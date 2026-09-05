import { SELF } from "cloudflare:test";
import { describe, expect, test, vi } from "vitest";

const MODERN_MCP_VERSION = "2026-07-28";

type McpResponse = {
  result?: {
    tools?: Array<{ name: string }>;
    content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>;
    isError?: boolean;
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

  test.each([{ projectId: "PRJ" }, { projectId: 123, workItemId: "WI-1" }])(
    "curated tools reject malformed arguments before contacting Polarion: %j",
    async (args) => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      try {
        const { body } = await mcp("/mcp?codemode=false", "tools/call", {
          name: "getWorkItem",
          arguments: args,
        });
        expect(body.result?.isError).toBe(true);
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    },
  );

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

  test("code reports non-Error throws", async () => {
    const { body } = await mcp("/mcp", "tools/call", {
      name: "code",
      arguments: { code: "async () => { throw 'string-boom'; }" },
    });
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain("string-boom");
  });

  test.each([
    "async _ => 42",
    "async () => 42",
    "(async () => 42)",
    "// leading comment\nasync _ => 42 // trailing comment",
    "```js\nasync _ => 42\n```",
  ])("code evaluates valid JavaScript functions: %s", async (code) => {
    const { body } = await mcp("/mcp", "tools/call", {
      name: "code",
      arguments: { code },
    });
    expect(body.result?.isError).not.toBe(true);
    expect(body.result?.content?.[0]?.text).toBe("42");
  });

  test.each(["return 42;", "async () => { throw ''; }"])(
    "code rejects invalid input or thrown values: %s",
    async (code) => {
      const { body } = await mcp("/mcp", "tools/call", {
        name: "code",
        arguments: { code },
      });
      expect(body.result?.isError).toBe(true);
    },
  );

  test("code runs an arrow function after a leading comment", async () => {
    const { body } = await mcp("/mcp", "tools/call", {
      name: "code",
      arguments: { code: "// query projects\nasync () => ({ ok: true })" },
    });
    expect(body.result?.isError).not.toBe(true);
    expect(JSON.parse(body.result?.content?.[0]?.text ?? "{}")).toEqual({ ok: true });
  });

  test("read_attachment keeps PNG when the full WebP reply would be larger", async () => {
    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90,
      0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8,
      0xcf, 0xc0, 0x00, 0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe, 0xd4, 0x59, 0x00, 0x00,
      0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/attachments/A-1/content")) {
        return Promise.resolve(new Response(png, { headers: { "content-type": "image/png" } }));
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });

    try {
      const { body } = await mcp("/mcp", "tools/call", {
        name: "read_attachment",
        arguments: {
          contentUrl: "/projects/PRJ/workitems/WI-1/attachments/A-1/content",
        },
      });
      const image = body.result?.content?.find((part) => part.type === "image");
      const text = body.result?.content?.find((part) => part.type === "text")?.text ?? "{}";
      expect(image?.mimeType).toBe("image/png");
      expect(image?.data).toMatch(/^[A-Za-z0-9+/]+=*$/);
      expect(JSON.parse(text)).toMatchObject({
        kind: "attachment",
        mimeType: "image/png",
      });
      expect(JSON.parse(text)).not.toHaveProperty("conversion");
      expect(Uint8Array.from(atob(image!.data!), (char) => char.charCodeAt(0))).toEqual(png);
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
