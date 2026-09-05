import { createMcpHandler } from "@modelcontextprotocol/server";
import { runWithPolarionAccessToken } from "./request-context";
import { createServer } from "./server";

export { PolarionDispatcher } from "./tools/code";

const mcpHandler = createMcpHandler(
  ({ requestInfo }) => {
    if (!requestInfo) throw new Error("The Polarion MCP server requires an HTTP request");
    return createServer(new URL(requestInfo.url).searchParams.get("codemode") !== "false");
  },
  { maxSubscriptions: 0, responseMode: "json" },
);

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/readyz")) {
      return Response.json({ ok: true });
    }
    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    return await runWithPolarionAccessToken(token, () =>
      mcpHandler.fetch(request, {
        authInfo: token ? { token, clientId: "polarion-mcp-client", scopes: [] } : undefined,
      }),
    );
  },
};
