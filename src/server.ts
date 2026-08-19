import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isCodeModeProcess } from "./code-mode.ts";
import { createMcpHttpHandler } from "./http-handler.ts";
import { createPublicServer } from "./public-server.ts";

// ---------- start ----------

const isStdio = Deno.args.includes("--stdio");
const resolveAccessToken = isStdio
  ? () => Deno.env.get("POLARION_ACCESS_TOKEN")
  : (extra: { authInfo?: { token?: string } }) => extra.authInfo?.token;
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
  const codeMode = isCodeModeProcess();
  const server = await createPublicServer({
    resolveAccessToken,
    codeMode,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Polarion MCP running in stdio mode${codeMode ? "" : " (codemode=false)"}`);
} else {
  // Production HTTP mode: token comes from each client's Authorization header
  const port = httpPort();
  const [codeModeServer, directServer] = await Promise.all([
    createPublicServer({ resolveAccessToken, codeMode: true }),
    createPublicServer({ resolveAccessToken, codeMode: false }),
  ]);
  const codeModeTransport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  const directTransport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  await Promise.all([
    codeModeServer.connect(codeModeTransport),
    directServer.connect(directTransport),
  ]);

  const handler = createMcpHttpHandler({
    handleCodeMode: (req, extra) => codeModeTransport.handleRequest(req, extra),
    handleDirect: (req, extra) => directTransport.handleRequest(req, extra),
  });

  Deno.serve({ port }, handler);

  console.log(
    `Polarion MCP running on http://localhost:${port}/mcp (health: /healthz, TLS should terminate at the proxy/load balancer)`,
  );
}
