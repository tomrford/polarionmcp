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
  const port = httpPort();
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  await server.connect(transport);

  Deno.serve({ port }, async (req) => {
    const url = new URL(req.url);
    if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/readyz")) {
      return Response.json({ ok: true });
    }

    if (url.pathname !== "/mcp") {
      return new Response("Not found", { status: 404 });
    }

    if (req.method === "POST") {
      const authHeader = req.headers.get("authorization");
      const token = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1];

      return transport.handleRequest(req, {
        authInfo: token ? { token, clientId: "polarion-mcp-client", scopes: [] } : undefined,
      });
    }

    if (req.method === "GET" || req.method === "DELETE") {
      return new Response("Method not allowed", { status: 405 });
    }

    return new Response("Method not allowed", { status: 405 });
  });

  console.log(
    `Polarion MCP running on http://localhost:${port}/mcp (health: /healthz, TLS should terminate at the proxy/load balancer)`,
  );
}
