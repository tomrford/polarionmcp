import { createMcpHandler } from "@modelcontextprotocol/server";
import { createServer } from "./server";

export const MCP_ROUTE = "/mcp";

export function isCodeMode(url: URL) {
  return url.searchParams.get("codemode") !== "false";
}

export function createAuthenticatedHandler() {
  return createMcpHandler(
    ({ requestInfo }) => {
      if (!requestInfo) throw new Error("The Polarion MCP server requires an HTTP request");
      return createServer(isCodeMode(new URL(requestInfo.url)));
    },
    { maxSubscriptions: 0, responseMode: "json" },
  );
}

function bearerToken(request: Request): string | undefined {
  return request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
}

export async function handleMcpRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== MCP_ROUTE) return new Response("Not found", { status: 404 });
  if (request.method === "GET" || request.method === "DELETE") {
    return new Response("Method not allowed", { status: 405 });
  }
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const token = bearerToken(request);
  const handler = createAuthenticatedHandler();
  return handler.fetch(request, {
    authInfo: token ? { token, clientId: "polarion-mcp-client", scopes: [] } : undefined,
  });
}
