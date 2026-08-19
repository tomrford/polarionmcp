import { handleMcpRequest, MCP_ROUTE } from "./mcp-handler";
import { runWithPolarionAccessToken } from "./request-context";

export { PolarionDispatcher } from "./tools/code";

function healthResponse() {
  return Response.json({ ok: true });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/readyz")) {
      return healthResponse();
    }
    if (url.pathname !== MCP_ROUTE) return new Response("Not found", { status: 404 });

    const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    return await runWithPolarionAccessToken(token, () => handleMcpRequest(request));
  },
};
