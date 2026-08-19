import { describe, expect, test } from "./test/test.ts";
import { createMcpHttpHandler, type HttpAuthExtra } from "./http-handler.ts";

describe("createMcpHttpHandler", () => {
  function handler() {
    const calls: Array<{ mode: "code" | "direct"; extra: HttpAuthExtra }> = [];
    const fetchHandler = createMcpHttpHandler({
      handleCodeMode: (_req, extra) => {
        calls.push({ mode: "code", extra });
        return new Response("code");
      },
      handleDirect: (_req, extra) => {
        calls.push({ mode: "direct", extra });
        return new Response("direct");
      },
    });
    return { calls, fetchHandler };
  }

  test("serves unauthenticated health checks", async () => {
    const { calls, fetchHandler } = handler();

    const health = await fetchHandler(new Request("http://localhost/healthz"));
    const ready = await fetchHandler(new Request("http://localhost/readyz"));

    expect(health.status).toBe(200);
    expect(ready.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
    expect(calls).toEqual([]);
  });

  test("rejects unknown paths and non-POST MCP methods", async () => {
    const { fetchHandler } = handler();

    expect((await fetchHandler(new Request("http://localhost/other"))).status).toBe(404);
    expect((await fetchHandler(new Request("http://localhost/mcp"))).status).toBe(405);
    expect(
      (await fetchHandler(new Request("http://localhost/mcp", { method: "DELETE" }))).status,
    ).toBe(405);
  });

  test("routes /mcp to code mode by default and /mcp?codemode=false to the direct server", async () => {
    const { calls, fetchHandler } = handler();

    const codeResponse = await fetchHandler(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer code-token" },
      }),
    );
    const directResponse = await fetchHandler(
      new Request("http://localhost/mcp?codemode=false", {
        method: "POST",
        headers: { Authorization: "Bearer direct-token" },
      }),
    );

    expect(await codeResponse.text()).toBe("code");
    expect(await directResponse.text()).toBe("direct");
    expect(calls).toEqual([
      {
        mode: "code",
        extra: { authInfo: { token: "code-token", clientId: "polarion-mcp-client", scopes: [] } },
      },
      {
        mode: "direct",
        extra: { authInfo: { token: "direct-token", clientId: "polarion-mcp-client", scopes: [] } },
      },
    ]);
  });
});
