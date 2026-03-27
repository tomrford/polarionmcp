import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "./register.ts";

// ---------- start ----------

const server = createServer();
const isStdio = process.argv.includes("--stdio");
const defaultHttpPort = 8080;

function httpPort(): number {
  const rawPort = process.env["PORT"];
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

  Bun.serve({
    port,
    routes: {
      "/mcp": {
        POST: async (req) => {
          // Check for existing session
          const sessionId = req.headers.get("mcp-session-id");
          let transport: Transport;

          if (sessionId && sessions.has(sessionId)) {
            transport = sessions.get(sessionId)!;
          } else if (!sessionId) {
            // New session — create transport
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

          // Extract bearer token and pass as authInfo
          const authHeader = req.headers.get("authorization");
          const token = authHeader?.replace(/^Bearer\s+/i, "");

          return transport.handleRequest(req, {
            authInfo: token ? { token, clientId: "polarion-mcp-client", scopes: [] } : undefined,
          });
        },
        GET: async (req) => {
          const sessionId = req.headers.get("mcp-session-id");
          const transport = sessionId ? sessions.get(sessionId) : undefined;
          if (!transport) {
            return new Response("Session not found", { status: 404 });
          }
          return transport.handleRequest(req);
        },
        DELETE: async (req) => {
          const sessionId = req.headers.get("mcp-session-id");
          const transport = sessionId ? sessions.get(sessionId) : undefined;
          if (!transport) {
            return new Response("Session not found", { status: 404 });
          }
          return transport.handleRequest(req);
        },
      },
    },
  });

  console.log(
    `Polarion MCP running on http://localhost:${port}/mcp (TLS should terminate at the proxy/load balancer)`
  );
}
