import { SELF } from "cloudflare:test";
import { describe, expect, test } from "vitest";

type McpResponse = {
  result?: {
    tools?: Array<{ name: string }>;
    content?: Array<{ text: string }>;
  };
};

async function mcp(path: string, method: string, params: Record<string, unknown> = {}) {
  const response = await SELF.fetch(`https://example.com${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer test-token",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as McpResponse;
  return { response, body };
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
    const names = (body.result?.tools ?? []).map((tool: { name: string }) => tool.name).sort();
    expect(names).toEqual(["code", "read_attachment", "search"]);
  });

  test("?codemode=false exposes curated Polarion tools plus read_attachment", async () => {
    const { body } = await mcp("/mcp?codemode=false", "tools/list");
    const names: string[] = (body.result?.tools ?? []).map((tool: { name: string }) => tool.name);
    expect(names).toContain("read_attachment");
    expect(names).toContain("getProjects");
    expect(names).toContain("getWorkItems");
    expect(names).toContain("patchWorkItem");
    expect(names).not.toContain("search");
    expect(names).not.toContain("code");
    expect(names).not.toContain("createProject");
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
