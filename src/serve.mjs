import { spawn } from "node:child_process";
import { createServer, request as proxyRequest } from "node:http";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const OPTIONAL_BINDINGS = [
  "POLARION_GUIDELINES",
  "REST_PAGE_SIZE",
  "FETCH_CONCURRENCY_COUNT",
  "READ_ATTACHMENT_INLINE_RESULT_MAX_BYTES",
];

function forwardHeaders(headers) {
  const excluded = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    ...String(headers.connection ?? "")
      .toLowerCase()
      .split(",")
      .map((name) => name.trim()),
  ]);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !excluded.has(name)));
}

export function createSupervisor({
  binary = process.env.WORKERD_BINARY ?? fileURLToPath(import.meta.resolve("workerd/bin/workerd")),
  config = "dist/config.capnp",
  env = process.env,
  timeoutMs = 30_000,
  maxConcurrent = 4,
} = {}) {
  const children = new Set();
  const server = createServer(async (request, response) => {
    const path = request.url.split("?", 1)[0];
    if (request.method === "GET" && ["/healthz", "/readyz"].includes(path)) {
      response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      return;
    }
    if (path !== "/mcp" || request.method !== "POST") {
      response.writeHead(path === "/mcp" ? 405 : 404).end();
      return;
    }
    if (children.size >= maxConcurrent) {
      response.writeHead(503, { "retry-after": "1" }).end("Server is busy");
      return;
    }

    // Standalone workerd has no CPU limiter. The watchdog must live in another process.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Request timed out")), timeoutMs);
    const cancel = () => controller.abort(new Error("Client disconnected"));
    request.once("aborted", cancel);
    response.once("close", cancel);
    const child = spawn(
      binary,
      ["serve", config, "--experimental", "--socket-addr=http=127.0.0.1:0", "--control-fd=3"],
      {
        env: { ...Object.fromEntries(OPTIONAL_BINDINGS.map((name) => [name, ""])), ...env },
        stdio: ["ignore", "ignore", "inherit", "pipe"],
        signal: controller.signal,
        killSignal: "SIGKILL",
      },
    );
    children.add(child);
    const exited = new Promise((resolve) =>
      child.once("close", () => {
        children.delete(child);
        resolve();
      }),
    );
    const lines = createInterface({ input: child.stdio[3] });

    try {
      const port = await new Promise((resolve, reject) => {
        child.on("error", reject);
        child.once("exit", () => reject(new Error("workerd exited before becoming ready")));
        lines.once("close", () => reject(new Error("workerd closed its readiness channel")));
        lines.on("line", (line) => {
          try {
            const message = JSON.parse(line);
            if (message.event === "listen" && message.socket === "http") resolve(message.port);
          } catch (error) {
            reject(error);
          }
        });
      });
      await new Promise((resolve, reject) => {
        controller.signal.throwIfAborted();
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
          once: true,
        });
        response.once("error", reject);
        const upstream = proxyRequest(
          {
            hostname: "127.0.0.1",
            port,
            path: request.url,
            method: request.method,
            headers: forwardHeaders(request.headers),
            agent: false,
            signal: controller.signal,
          },
          (result) => {
            // Legacy MCP sends SSE headers before evaluating the tool. Keep the ability
            // to report a 504 until it actually starts sending response content.
            const writeHeaders = () => {
              if (!response.headersSent) {
                response.writeHead(result.statusCode, forwardHeaders(result.headers));
              }
            };
            result.once("data", writeHeaders);
            result.once("end", writeHeaders);
            result.on("error", reject);
            response.once("finish", resolve);
            result.pipe(response);
          },
        );
        upstream.on("error", reject);
        request.on("error", reject);
        request.pipe(upstream);
      });
    } catch (error) {
      if (!response.destroyed && !response.headersSent) {
        const timedOut = controller.signal.reason?.message === "Request timed out";
        response
          .writeHead(timedOut ? 504 : 502)
          .end(
            timedOut
              ? `Request exceeded ${timeoutMs}ms. Polarion writes already sent may have completed.`
              : "Worker request failed",
          );
      } else {
        response.destroy();
      }
      if (!controller.signal.aborted) console.error(error.message);
    } finally {
      clearTimeout(timer);
      request.off("aborted", cancel);
      response.off("close", cancel);
      lines.close();
      controller.abort();
      child.kill("SIGKILL");
      await exited;
    }
  });

  server.once("close", () => {
    for (const child of children) child.kill("SIGKILL");
  });
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (!process.env.POLARION_BASE_URL) throw new Error("POLARION_BASE_URL is not set");
  const server = createSupervisor();
  server.listen(Number(process.env.PORT ?? 8080), "0.0.0.0");
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      server.closeAllConnections();
      server.close();
    });
  }
}
