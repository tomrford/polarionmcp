import {
  type AuthInfo,
  createMcpHandler,
  isLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { polarionConfig } from "./config";
import { runWithPolarionAccessToken } from "./request-context";
import { createServer } from "./server";

// Fail host startup on invalid configuration rather than failing every request.
polarionConfig();

function codemodeEnabled(request: Request) {
  return new URL(request.url).searchParams.get("codemode") !== "false";
}

const modernHandler = createMcpHandler(
  ({ requestInfo }) => {
    if (!requestInfo) throw new Error("The Polarion MCP server requires an HTTP request");
    return createServer(codemodeEnabled(requestInfo));
  },
  { maxSubscriptions: 0, responseMode: "json", legacy: "reject" },
);

// The SDK's own 2025-era fallback always answers over SSE. Serve those revisions as plain JSON.
async function handleLegacy(request: Request, authInfo: AuthInfo | undefined) {
  const server = createServer(codemodeEnabled(request));
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request, { authInfo });
  } finally {
    await server.close();
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    const authInfo = token ? { token, clientId: "polarion-mcp-client", scopes: [] } : undefined;
    return await runWithPolarionAccessToken(token, async () =>
      (await isLegacyRequest(request))
        ? await handleLegacy(request, authInfo)
        : await modernHandler.fetch(request, { authInfo }),
    );
  },
};
