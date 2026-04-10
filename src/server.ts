import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createPublicServer } from "./public-server.ts";

// ---------- start ----------

const isStdio = Deno.args.includes("--stdio");
const server = await createPublicServer({
  resolveAccessToken: isStdio
    ? () => Deno.env.get("POLARION_ACCESS_TOKEN")
    : (extra) => extra.authInfo?.token,
});
const defaultHttpPort = 8080;

function httpPort(): number {
  const rawPort = Deno.env.get("PORT");
  if (!rawPort) return defaultHttpPort;

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT value: ${rawPort}`);
  }
  return port;
}

if (isStdio) {
  // Local dev/test mode: token comes from POLARION_ACCESS_TOKEN env var
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Polarion MCP running in stdio mode");
} else {
  // Production HTTP mode: token comes from each client's Authorization header
  type Transport = InstanceType<typeof WebStandardStreamableHTTPServerTransport>;
  const sessions = new Map<string, Transport>();

  const port = httpPort();

  Deno.serve({ port }, async (req) => {
    const url = new URL(req.url);
    if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/readyz")) {
      return Response.json({ ok: true });
    }

    if (url.pathname !== "/mcp") {
      return new Response("Not found", { status: 404 });
    }

    const sessionId = req.headers.get("mcp-session-id");
    const existingTransport = sessionId ? sessions.get(sessionId) : undefined;

    if (req.method === "POST") {
      let transport: Transport;

      if (existingTransport) {
        transport = existingTransport;
      } else if (!sessionId) {
        transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, transport);
          },
          onsessionclosed: (id) => {
            sessions.delete(id);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        await server.connect(transport);
      } else {
        return new Response("Session not found", { status: 404 });
      }

      const authHeader = req.headers.get("authorization");
      const token = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1];

      return transport.handleRequest(req, {
        authInfo: token ? { token, clientId: "polarion-mcp-client", scopes: [] } : undefined,
      });
    }

    if (req.method === "GET" || req.method === "DELETE") {
      if (!existingTransport) {
        return new Response("Session not found", { status: 404 });
      }
      return existingTransport.handleRequest(req);
    }

    return new Response("Method not allowed", { status: 405 });
  });

  console.log(
    `Polarion MCP running on http://localhost:${port}/mcp (health: /healthz, TLS should terminate at the proxy/load balancer)`,
  );
}
