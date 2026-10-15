import { spawn } from "node:child_process";
import { createServer, request as proxyRequest } from "node:http";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

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
  binary = process.env.WORKERD_BINARY ?? createRequire(import.meta.url)("workerd").default,
  config = "dist/config.capnp",
  env = process.env,
  timeoutMs = 30_000,
  maxConcurrent = 4,
  maxQueued = 32,
  maxRequestsPerWorker = 100,
} = {}) {
  const slots = Array.from({ length: maxConcurrent }, () => ({ kind: "starting", child: null }));
  const queue = new Set();
  let closing = false;

  function finish(job, outcome) {
    if (job.kind === "finished") return;
    const slot = job.slot;
    job.kind = "finished";
    queue.delete(job);
    clearTimeout(job.timer);
    job.request.off("error", job.cancel);
    job.response.off("close", job.cancel);
    job.response.off("error", job.cancel);
    job.response.off("finish", job.success);
    job.request.unpipe(job.upstream);
    job.upstream?.destroy();
    if (outcome !== "success") {
      if (slot) stop(slot, !closing);
      if (!job.response.destroyed && !job.response.headersSent && outcome !== "disconnected") {
        const status = outcome === "timeout" ? 504 : outcome === "shutdown" ? 503 : 502;
        const writesWarning = "Polarion writes already sent may have completed.";
        const dispatched = job.startedAt !== undefined;
        job.response
          .writeHead(status)
          .end(
            outcome === "timeout"
              ? `Request exceeded ${timeoutMs}ms.${dispatched ? ` ${writesWarning}` : ""}`
              : outcome === "shutdown"
                ? "Server is shutting down"
                : dispatched
                  ? `Worker request failed. ${writesWarning}`
                  : "Worker request failed",
          );
      } else {
        job.response.destroy();
      }
    } else if (slot?.kind === "busy" && slot.job === job) {
      slot.job = null;
      if (++slot.completedRequests >= maxRequestsPerWorker) {
        console.log(
          JSON.stringify({
            event: "worker_recycled",
            workerPid: slot.child.pid,
            completedRequests: slot.completedRequests,
          }),
        );
        stop(slot, true);
      } else if (closing) {
        stop(slot, false);
      } else {
        slot.kind = "idle";
      }
    }
    const completedAt = performance.now();
    console.log(
      JSON.stringify({
        event: "request_completed",
        outcome,
        status: job.response.statusCode,
        queueMs: Math.round((job.startedAt ?? completedAt) - job.arrivedAt),
        workerMs: job.startedAt === undefined ? 0 : Math.round(completedAt - job.startedAt),
        durationMs: Math.round(completedAt - job.arrivedAt),
        ...(job.workerPid ? { workerPid: job.workerPid } : {}),
      }),
    );
    drain();
  }

  function stop(slot, restart) {
    clearTimeout(slot.retryTimer);
    if (slot.kind === "stopping" || slot.kind === "failed") return;
    slot.kind = "stopping";
    slot.restart = restart;
    clearTimeout(slot.bootTimer);
    slot.lines?.close();
    slot.child?.kill("SIGKILL");
  }

  // Back off from 1s to 30s while a host keeps failing to start, e.g. on invalid configuration.
  function retryLater(slot) {
    slot.retryDelay = Math.min((slot.retryDelay ?? 500) * 2, 30_000);
    slot.retryTimer = setTimeout(() => start(slot), slot.retryDelay);
  }

  function start(slot) {
    if (closing) return;
    slot.kind = "starting";
    slot.job = null;
    slot.restart = false;
    slot.completedRequests = 0;
    let child;
    try {
      child = spawn(
        binary,
        ["serve", config, "--experimental", "--socket-addr=http=127.0.0.1:0", "--control-fd=3"],
        {
          env,
          stdio: ["ignore", "ignore", "inherit", "pipe"],
        },
      );
    } catch (error) {
      // spawn throws synchronously for some failures (e.g. EFTYPE on Windows) instead of emitting "error".
      console.error(error);
      slot.kind = "failed";
      retryLater(slot);
      drain();
      return;
    }
    slot.child = child;
    slot.reaped = new Promise((resolve) => {
      child.once("close", () => {
        clearTimeout(slot.bootTimer);
        slot.lines?.close();
        const job = slot.job;
        const restart = slot.kind === "stopping" ? slot.restart : slot.kind !== "starting";
        slot.kind = "stopping";
        slot.child = null;
        slot.job = null;
        if (job) finish(job, "worker_failed");
        resolve();
        if (restart && !closing) start(slot);
        else {
          slot.kind = "failed";
          if (!closing) retryLater(slot);
        }
        drain();
      });
    });
    const startupFailed = () => {
      if (slot.kind === "starting") stop(slot, false);
    };
    child.on("error", () => {
      if (slot.kind === "busy") finish(slot.job, "worker_failed");
      else startupFailed();
    });
    slot.bootTimer = setTimeout(startupFailed, timeoutMs);
    const lines = createInterface({ input: child.stdio[3] });
    slot.lines = lines;
    lines.once("close", startupFailed);
    lines.on("line", (line) => {
      if (slot.kind !== "starting") return;
      try {
        const message = JSON.parse(line);
        if (message.event !== "listen" || message.socket !== "http") return;
        if (!Number.isInteger(message.port) || message.port <= 0 || message.port > 65535) {
          startupFailed();
          return;
        }
        clearTimeout(slot.bootTimer);
        slot.retryDelay = undefined;
        slot.port = message.port;
        slot.kind = "idle";
        lines.close();
        drain();
      } catch {
        startupFailed();
      }
    });
  }

  function dispatch(job, slot) {
    if (performance.now() >= job.arrivedAt + timeoutMs) {
      finish(job, "timeout");
      return;
    }
    queue.delete(job);
    job.kind = "running";
    job.slot = slot;
    job.startedAt = performance.now();
    job.workerPid = slot.child.pid;
    slot.kind = "busy";
    slot.job = job;
    const upstream = proxyRequest(
      {
        hostname: "127.0.0.1",
        port: slot.port,
        path: job.request.url,
        method: job.request.method,
        headers: forwardHeaders(job.request.headers),
        agent: false,
      },
      (result) => {
        if (job.kind === "finished") {
          result.destroy();
          return;
        }
        job.response.writeHead(result.statusCode, {
          ...forwardHeaders(result.headers),
          "server-timing": `queue;dur=${Math.round(job.startedAt - job.arrivedAt)}`,
        });
        result.on("error", job.fail);
        result.once("aborted", job.fail);
        result.pipe(job.response);
      },
    );
    job.upstream = upstream;
    upstream.on("error", job.fail);
    job.request.pipe(upstream);
  }

  function drain() {
    if (closing) return;
    for (const slot of slots) {
      if (slot.kind !== "idle" || queue.size === 0) continue;
      dispatch(queue.values().next().value, slot);
    }
    if (slots.every((slot) => slot.kind === "failed")) {
      for (const job of queue) finish(job, "worker_failed");
    }
  }

  const server = createServer((request, response) => {
    const path = request.url.split("?", 1)[0];
    if (request.method === "GET" && ["/healthz", "/readyz"].includes(path)) {
      const ready = !closing && slots.some((slot) => slot.kind === "idle" || slot.kind === "busy");
      const ok = path === "/healthz" || ready;
      response
        .writeHead(ok ? 200 : 503, { "content-type": "application/json" })
        .end(JSON.stringify({ ok }));
      return;
    }
    if (path !== "/mcp" || request.method !== "POST") {
      response.writeHead(path === "/mcp" ? 405 : 404).end();
      return;
    }
    if (closing) {
      response.writeHead(503, { "retry-after": "1" }).end("Server is shutting down");
      return;
    }
    if (queue.size >= maxQueued && !slots.some((slot) => slot.kind === "idle")) {
      response.writeHead(503, { "retry-after": "1" }).end("Server is busy");
      return;
    }
    const job = { request, response, kind: "queued", arrivedAt: performance.now() };
    job.cancel = () => finish(job, "disconnected");
    job.fail = () => finish(job, "worker_failed");
    job.success = () => finish(job, "success");
    // Standalone workerd has no CPU limiter. The watchdog must live in another process.
    job.timer = setTimeout(() => finish(job, "timeout"), timeoutMs);
    // Client socket failures are disconnections, not worker failures.
    request.once("error", job.cancel);
    response.once("close", job.cancel);
    response.once("error", job.cancel);
    response.once("finish", job.success);
    request.pause();
    queue.add(job);
    drain();
  });

  server.once("listening", () => {
    for (const slot of slots) start(slot);
  });
  const close = server.close.bind(server);
  let shutdown;
  server.close = (callback) => {
    if (!shutdown) {
      // Refuse new and queued work, but let running requests finish within their own deadline.
      closing = true;
      for (const job of queue) finish(job, "shutdown");
      for (const slot of slots) {
        if (!slot.job) stop(slot, false);
      }
      const reaped = Promise.all(slots.map((slot) => slot.reaped));
      shutdown = new Promise((resolve) => {
        close((error) => reaped.then(() => resolve(error)));
      });
    }
    if (callback) void shutdown.then(callback);
    return server;
  };
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (!process.env.POLARION_BASE_URL) throw new Error("POLARION_BASE_URL is not set");
  const port = Number(process.env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer from 1 to 65535; received ${process.env.PORT}`);
  }
  const server = createSupervisor();
  server.listen(port, "0.0.0.0");
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      server.close();
      server.closeIdleConnections();
    });
  }
}
