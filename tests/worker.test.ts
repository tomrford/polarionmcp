import { SELF } from "cloudflare:test";
import { describe, expect, test, vi } from "vitest";

const MODERN_MCP_VERSION = "2026-07-28";

type McpResponse = {
  result?: {
    tools?: Array<{ name: string }>;
    content?: Array<{ text: string }>;
  };
};

async function parseMcpResult(response: Response): Promise<McpResponse> {
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const dataLine = text.split("\n").find((line) => line.startsWith("data:"));
    if (!dataLine) throw new Error(`SSE response had no data frame: ${text}`);
    return JSON.parse(dataLine.slice("data:".length).trim()) as McpResponse;
  }
  return JSON.parse(text) as McpResponse;
}

async function mcp(path: string, method: string, params: Record<string, unknown> = {}) {
  const name = typeof params.name === "string" ? params.name : undefined;
  const response = await SELF.fetch(`https://example.com${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer test-token",
      "MCP-Protocol-Version": MODERN_MCP_VERSION,
      "Mcp-Method": method,
      ...(name ? { "Mcp-Name": name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN_MCP_VERSION,
          "io.modelcontextprotocol/clientInfo": { name: "polarion-tests", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  return { response, body: await parseMcpResult(response) };
}

describe("worker HTTP", () => {
  test("healthz and readyz return ok", async () => {
    for (const path of ["/healthz", "/readyz"]) {
      const response = await SELF.fetch(`https://example.com${path}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    }
  });

  test("unknown paths are 404", async () => {
    const response = await SELF.fetch("https://example.com/nope");
    expect(response.status).toBe(404);
  });

  test("GET /mcp is 405", async () => {
    const response = await SELF.fetch("https://example.com/mcp");
    expect(response.status).toBe(405);
  });
});

describe("MCP public surface", () => {
  test("default /mcp exposes search, code, and read_attachment", async () => {
    const { body } = await mcp("/mcp", "tools/list");
    const names = (body.result?.tools ?? []).map((tool) => tool.name).sort();
    expect(names).toEqual(["code", "read_attachment", "search"]);
  });

  test("?codemode=false exposes curated Polarion tools plus read_attachment", async () => {
    const { body } = await mcp("/mcp?codemode=false", "tools/list");
    const names = (body.result?.tools ?? []).map((tool) => tool.name);
    expect(names).toContain("read_attachment");
    expect(names).toContain("getProjects");
    expect(names).toContain("getWorkItems");
    expect(names).toContain("patchWorkItem");
    expect(names).not.toContain("search");
    expect(names).not.toContain("code");
    expect(names).not.toContain("createProject");
  });

  test("code RPCs curated Polarion tools with host-side auth", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/projects")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: [{ id: "PRJ", type: "projects", attributes: { name: "Project" } }],
              meta: { totalCount: 1 },
              links: {},
            }),
            { headers: { "content-type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });

    try {
      const { body } = await mcp("/mcp", "tools/call", {
        name: "code",
        arguments: { code: "async () => await codemode.getProjects({})" },
      });
      const payload = JSON.parse(body.result?.content?.[0]?.text ?? "{}");
      expect(payload).toMatchObject({
        kind: "collection",
        items: [{ id: "PRJ", type: "projects" }],
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("search returns catalog matches", async () => {
    const { body } = await mcp("/mcp", "tools/call", {
      name: "search",
      arguments: { query: "workflow workitems" },
    });
    const payload = JSON.parse(body.result?.content?.[0]?.text ?? "{}");
    expect(payload.total_matches).toBeGreaterThan(0);
    expect(
      payload.matches.some(
        (entry: { callable: string }) =>
          entry.callable === "codemode.getWorkflowActionsForWorkItem",
      ),
    ).toBe(true);
  });
});
