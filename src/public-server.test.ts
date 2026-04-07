import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type CallToolResult, McpError } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, test, vi } from "./test/test.ts";
import { createPublicServer } from "./public-server.ts";

describe("createPublicServer", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn<typeof globalThis, "fetch">>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockReset();
    Deno.env.delete("POLARION_ACCESS_TOKEN");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Deno.env.delete("POLARION_ACCESS_TOKEN");
  });

  async function connectClient(options: {
    authToken?: string;
    resolveAccessToken: Parameters<typeof createPublicServer>[0]["resolveAccessToken"];
  }) {
    const server = await createPublicServer({
      resolveAccessToken: options.resolveAccessToken,
    });
    const client = new Client({
      name: "test-client",
      version: "1.0.0",
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);

    if (options.authToken) {
      const originalSend = clientTransport.send.bind(clientTransport);
      const authToken = options.authToken;
      clientTransport.send = (message, sendOptions) =>
        originalSend(message, {
          ...sendOptions,
          authInfo: { token: authToken, clientId: "test-client", scopes: [] },
        });
    }

    return { client, server, clientTransport, serverTransport };
  }

  const httpAccessToken = (extra: { authInfo?: { token?: string } }) => extra.authInfo?.token;
  const stdioAccessToken = () => Deno.env.get("POLARION_ACCESS_TOKEN");

  function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  test("exposes search and code tools and no resources", async () => {
    const { client, server, clientTransport, serverTransport } = await connectClient({
      resolveAccessToken: httpAccessToken,
    });

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

  test("runs codemode against the internal generated Polarion tool surface", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: { type: "fieldsmetadata", id: "fm", attributes: { fields: [] } },
        links: {},
      }),
    );

    const { client, server, clientTransport, serverTransport } = await connectClient({
      authToken: "bridge-token",
      resolveAccessToken: httpAccessToken,
    });

    const result = await client.callTool({
      name: "code",
      arguments: {
        code: 'async () => await codemode.getGlobalFieldsMetadata({ resourceType: "workitems" })',
      },
    });

    const textResult = result as CallToolResult;
    expect(textResult.isError).toBeUndefined();
    expect(JSON.parse((textResult.content[0] as { text: string }).text)).toMatchObject({
      data: { type: "fieldsmetadata" },
    });

    const [url, init] = fetchSpy.calls[0]!.args as [string, RequestInit];
    expect(url).toBe("https://example.invalid/actions/getFieldsMetadata?resourceType=workitems");
    expect(init.headers).toEqual({
      Accept: "application/json",
      Authorization: "Bearer bridge-token",
    });

    await Promise.all([
      client.close(),
      clientTransport.close(),
      serverTransport.close(),
      server.close(),
    ]);
  });

  test("bridges request auth into generated tool calls", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [{ id: "PRJ", type: "projects", attributes: { name: "Project" } }],
        meta: { totalCount: 1 },
        links: {},
      }),
    );

    const { client, server, clientTransport, serverTransport } = await connectClient({
      authToken: "bridge-token",
      resolveAccessToken: httpAccessToken,
    });

    const result = await client.callTool({
      name: "code",
      arguments: {
        code: "async () => await codemode.getProjects({ page: { size: 5 } })",
      },
    });

    const [url, init] = fetchSpy.calls[0]!.args as [string, RequestInit];
    expect(url).toBe("https://example.invalid/projects?page%5Bsize%5D=5&page%5Bnumber%5D=1");
    expect(init.headers).toEqual({
      Accept: "application/json",
      Authorization: "Bearer bridge-token",
    });

    const textResult = result as CallToolResult;
    expect(textResult.isError).toBeUndefined();
    expect(JSON.parse((textResult.content[0] as { text: string }).text)).toMatchObject({
      data: [{ id: "PRJ", type: "projects" }],
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
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [{ id: "PRJ", type: "projects", attributes: { name: "Project" } }],
        meta: { totalCount: 1 },
        links: {},
      }),
    );

    const { client, server, clientTransport, serverTransport } = await connectClient({
      resolveAccessToken: stdioAccessToken,
    });

    const result = await client.callTool({
      name: "code",
      arguments: {
        code: "async () => await codemode.getProjects({})",
      },
    });

    const [url, init] = fetchSpy.calls[0]!.args as [string, RequestInit];
    expect(url).toBe("https://example.invalid/projects?page%5Bsize%5D=20&page%5Bnumber%5D=1");
    expect(init.headers).toEqual({
      Accept: "application/json",
      Authorization: "Bearer env-token",
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

  test("search returns compact fuzzy matches with input and output summaries", async () => {
    const { client, server, clientTransport, serverTransport } = await connectClient({
      authToken: "bridge-token",
      resolveAccessToken: httpAccessToken,
    });

    const result = await client.callTool({
      name: "search",
      arguments: {
        query: "workflow workitems",
      },
    });

    const textResult = result as CallToolResult;
    const payload = JSON.parse((textResult.content[0] as { text: string }).text);
    expect(payload.total_matches).toBeGreaterThan(0);
    expect(
      payload.matches.some((entry: { callable: string }) =>
        entry.callable === "codemode.getWorkflowActionsForWorkItem"
      ),
    ).toBe(true);
    expect(
      payload.matches.every((entry: { input_summary: string; output_summary: string }) =>
        typeof entry.input_summary === "string" && typeof entry.output_summary === "string"
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
    const { client, server, clientTransport, serverTransport } = await connectClient({
      resolveAccessToken: httpAccessToken,
    });

    const tools = await client.listTools();
    const codeTool = tools.tools.find((tool) => tool.name === "code");

    expect(codeTool?.description).toContain("Before writing code, use the top-level search tool");
    expect(codeTool?.description).toContain("codemode.*");
    expect(codeTool?.description).toContain("codemode.getProjects");
    expect(codeTool?.description).not.toContain("declare const codemode");

    await Promise.all([
      client.close(),
      clientTransport.close(),
      serverTransport.close(),
      server.close(),
    ]);
  });

  test("rejects missing bridge auth in HTTP mode", async () => {
    const { client, server, clientTransport, serverTransport } = await connectClient({
      resolveAccessToken: httpAccessToken,
    });

    const result = await client.callTool({
      name: "code",
      arguments: {
        code: "async () => await codemode.getProjects({})",
      },
    });

    const textResult = result as CallToolResult;
    expect(textResult.isError).toBe(true);
    expect((textResult.content[0] as { text: string }).text).toContain(
      "No Polarion access token available",
    );
    expect(fetchSpy.calls).toHaveLength(0);

    await Promise.all([
      client.close(),
      clientTransport.close(),
      serverTransport.close(),
      server.close(),
    ]);
  });
});
