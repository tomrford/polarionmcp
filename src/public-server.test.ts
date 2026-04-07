import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type CallToolResult, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectCalledWith,
  test,
  vi,
} from "./test/test.ts";
import { client as polarionClient } from "./client.ts";
import { createPublicServer } from "./public-server.ts";

describe("createPublicServer", () => {
  let getSpy: ReturnType<typeof vi.spyOn<typeof polarionClient, "GET">>;

  beforeEach(() => {
    getSpy = vi.spyOn(polarionClient, "GET");
    getSpy.mockReset();
    Deno.env.delete("POLARION_ACCESS_TOKEN");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Deno.env.delete("POLARION_ACCESS_TOKEN");
  });

  async function connectClient(authToken?: string) {
    const server = await createPublicServer();
    const client = new Client({
      name: "test-client",
      version: "1.0.0",
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);

    if (authToken) {
      const originalSend = clientTransport.send.bind(clientTransport);
      clientTransport.send = (message, options) =>
        originalSend(message, {
          ...options,
          authInfo: { token: authToken, clientId: "test-client", scopes: [] },
        });
    }

    return { client, server, clientTransport, serverTransport };
  }

  test("exposes search and code tools and no resources", async () => {
    const { client, server, clientTransport, serverTransport } = await connectClient();

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(["code", "search"]);

    let error: unknown;
    try {
      await client.listResources();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(-32601);

    expect(client.getInstructions()).toContain("This server exposes two tools: search and code.");

    await Promise.all([
      client.close(),
      clientTransport.close(),
      serverTransport.close(),
      server.close(),
    ]);
  });

  test("runs codemode against the internal Polarion tool surface", async () => {
    const { client, server, clientTransport, serverTransport } = await connectClient();

    const result = await client.callTool({
      name: "code",
      arguments: {
        code:
          'async () => await codemode.polarion_api_help({ keyword: "workflow", resource_type: "workitems" })',
      },
    });

    expect("content" in result).toBe(true);
    if (!("content" in result)) return;

    const textResult = result as CallToolResult;
    expect(textResult.isError).toBeUndefined();
    expect(textResult.content[0]?.type).toBe("text");
    expect(JSON.parse((textResult.content[0] as { text: string }).text)).toMatchObject({
      summary: {
        total_matches: expect.any(Number),
      },
    });

    await Promise.all([
      client.close(),
      clientTransport.close(),
      serverTransport.close(),
      server.close(),
    ]);
  });

  test("bridges request auth into curated tool calls", async () => {
    getSpy.mockResolvedValueOnce({
      data: {
        data: [{ id: "PRJ", type: "projects", attributes: { name: "Project" } }],
        meta: { totalCount: 1 },
        links: {},
      },
      response: { ok: true, status: 200 },
    } as unknown as any);

    const { client, server, clientTransport, serverTransport } = await connectClient(
      "bridge-token",
    );

    const result = await client.callTool({
      name: "code",
      arguments: {
        code: "async () => await codemode.list_projects({ page_size: 5 })",
      },
    });

    expectCalledWith(getSpy, "/projects", {
      headers: { Authorization: "Bearer bridge-token" },
      params: {
        query: {
          "page[size]": 5,
          "page[number]": 1,
          query: undefined,
          fields: undefined,
        },
      },
    });

    const textResult = result as CallToolResult;
    expect(textResult.isError).toBeUndefined();
    expect(JSON.parse((textResult.content[0] as { text: string }).text)).toMatchObject({
      items: [{ id: "PRJ", type: "projects", attributes: { name: "Project" } }],
    });

    await Promise.all([
      client.close(),
      clientTransport.close(),
      serverTransport.close(),
      server.close(),
    ]);
  });

  test("uses stdio env auth when request auth is absent", async () => {
    Deno.env.set("POLARION_ACCESS_TOKEN", "env-token");
    getSpy.mockResolvedValueOnce({
      data: {
        data: [{ id: "PRJ", type: "projects", attributes: { name: "Project" } }],
        meta: { totalCount: 1 },
        links: {},
      },
      response: { ok: true, status: 200 },
    } as unknown as any);

    const { client, server, clientTransport, serverTransport } = await connectClient();

    const result = await client.callTool({
      name: "code",
      arguments: {
        code: "async () => await codemode.list_projects({})",
      },
    });

    expectCalledWith(getSpy, "/projects", {
      headers: { Authorization: "Bearer env-token" },
      params: {
        query: {
          "page[size]": 20,
          "page[number]": 1,
          query: undefined,
          fields: undefined,
        },
      },
    });

    const textResult = result as CallToolResult;
    expect(textResult.isError).toBeUndefined();

    await Promise.all([
      client.close(),
      clientTransport.close(),
      serverTransport.close(),
      server.close(),
    ]);
  });

  test("search returns fuzzy matches with callable names and schemas", async () => {
    const { client, server, clientTransport, serverTransport } = await connectClient();

    const result = await client.callTool({
      name: "search",
      arguments: {
        query: "workflow workitems",
      },
    });

    expect("content" in result).toBe(true);
    if (!("content" in result)) return;

    const textResult = result as CallToolResult;
    const payload = JSON.parse((textResult.content[0] as { text: string }).text);
    expect(payload.total_matches).toBeGreaterThan(0);
    expect(
      payload.matches.some((entry: { callable: string }) =>
        entry.callable.includes("work_item")
      ),
    ).toBe(true);
    expect(
      payload.matches.every((entry: { input_schema: unknown }) =>
        typeof entry.input_schema === "object"
      ),
    ).toBe(true);

    await Promise.all([
      client.close(),
      clientTransport.close(),
      serverTransport.close(),
      server.close(),
    ]);
  });

  test("uses compact custom code description", async () => {
    const { client, server, clientTransport, serverTransport } = await connectClient();

    const tools = await client.listTools();
    const codeTool = tools.tools.find((tool) => tool.name === "code");

    expect(codeTool?.description).toContain("Before writing code, use the top-level search tool");
    expect(codeTool?.description).toContain("codemode.*");
    expect(codeTool?.description).not.toContain("declare const codemode");

    await Promise.all([
      client.close(),
      clientTransport.close(),
      serverTransport.close(),
      server.close(),
    ]);
  });
});
