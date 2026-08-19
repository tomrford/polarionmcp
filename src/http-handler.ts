import { isCodeModeRequest } from "./code-mode.ts";

export type HttpAuthExtra = {
  authInfo?: { token: string; clientId: string; scopes: string[] };
};

export function createMcpHttpHandler(options: {
  handleCodeMode: (req: Request, extra: HttpAuthExtra) => Promise<Response> | Response;
  handleDirect: (req: Request, extra: HttpAuthExtra) => Promise<Response> | Response;
}) {
  return async (req: Request) => {
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
      const extra: HttpAuthExtra = {
        authInfo: token ? { token, clientId: "polarion-mcp-client", scopes: [] } : undefined,
      };
      const handle = isCodeModeRequest(url) ? options.handleCodeMode : options.handleDirect;
      return await handle(req, extra);
    }

    if (req.method === "GET" || req.method === "DELETE") {
      return new Response("Method not allowed", { status: 405 });
    }

    return new Response("Method not allowed", { status: 405 });
  };
}
