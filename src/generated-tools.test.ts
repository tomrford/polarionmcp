import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, test, vi } from "./test/test.ts";
import { createServer } from "./register.ts";
import { runWithPolarionAccessToken } from "./request-context.ts";

describe("generated tools", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn<typeof globalThis, "fetch">>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function connectClient() {
    const server = createServer();
    const client = new Client({
      name: "test-client",
      version: "1.0.0",
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);

    return { client, server, clientTransport, serverTransport };
  }

  async function callToolWithToken(
    client: Client,
    name: string,
    args: Record<string, unknown>,
    authToken = "token",
  ) {
    return await runWithPolarionAccessToken(authToken, async () =>
      await client.callTool({
        name,
        arguments: args,
      }));
  }

  function textPayload(result: CallToolResult) {
    const first = result.content[0];
    if (!first || first.type !== "text") throw new Error("Expected text content");
    return JSON.parse((first as { text: string }).text);
  }

  function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  test("getProjects shapes pagination and auth headers", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [{ id: "PRJ", type: "projects", attributes: { name: "Project" } }],
        meta: { totalCount: 1 },
        links: {},
      }),
    );

    const { client, server, clientTransport, serverTransport } = await connectClient();

    const result = await callToolWithToken(client, "getProjects", {
      query: "id:PRJ*",
      page: { size: 5, number: 2 },
    });

    const [url, init] = fetchSpy.calls[0]!.args as [string, RequestInit];
    expect(url).toBe(
      "https://example.invalid/projects?query=id%3APRJ*&page%5Bsize%5D=5&page%5Bnumber%5D=2",
    );
    expect(init.headers).toEqual({
      Accept: "application/json",
      Authorization: "Bearer token",
    });

    expect(textPayload(result as CallToolResult)).toMatchObject({
      data: [{ id: "PRJ", type: "projects" }],
    });

    await Promise.all([
      client.close(),
      clientTransport.close(),
      serverTransport.close(),
      server.close(),
    ]);
  });

  test("patchWorkItem sends JSON body and returns ok for 204", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const { client, server, clientTransport, serverTransport } = await connectClient();

    const result = await callToolWithToken(client, "patchWorkItem", {
      projectId: "PRJ",
      workItemId: "REQ-1",
      workflowAction: "start_progress",
      body: {
        data: {
          type: "workitems",
          id: "PRJ/REQ-1",
          attributes: { title: "Updated" },
        },
      },
    });

    const [url, init] = fetchSpy.calls[0]!.args as [string, RequestInit];
    expect(url).toBe(
      "https://example.invalid/projects/PRJ/workitems/REQ-1?workflowAction=start_progress",
    );
    expect(init.method).toBe("PATCH");
    expect(init.headers).toEqual({
      Accept: "application/json",
      Authorization: "Bearer token",
      "Content-Type": "application/json",
    });
    expect(init.body).toBe(
      JSON.stringify({
        data: {
          type: "workitems",
          id: "PRJ/REQ-1",
          attributes: { title: "Updated" },
        },
      }),
    );

    expect(textPayload(result as CallToolResult)).toEqual({ ok: true });

    await Promise.all([
      client.close(),
      clientTransport.close(),
      serverTransport.close(),
      server.close(),
    ]);
  });

  test("getProjectFieldsMetadata passes required query params", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: { id: "meta", type: "fieldsmetadata", attributes: { fields: [] } },
        links: {},
      }),
    );

    const { client, server, clientTransport, serverTransport } = await connectClient();

    const result = await callToolWithToken(client, "getProjectFieldsMetadata", {
      projectId: "PRJ",
      resourceType: "workitems",
      targetType: "requirement",
    });

    const [url] = fetchSpy.calls[0]!.args as [string, RequestInit];
    expect(url).toBe(
      "https://example.invalid/projects/PRJ/actions/getFieldsMetadata?resourceType=workitems&targetType=requirement",
    );
    expect(textPayload(result as CallToolResult)).toMatchObject({
      data: { type: "fieldsmetadata" },
    });

    await Promise.all([
      client.close(),
      clientTransport.close(),
      serverTransport.close(),
      server.close(),
    ]);
  });

  test("tool errors surface structured error payloads", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("bad request", { status: 400, headers: { "content-type": "text/plain" } }),
    );

    const { client, server, clientTransport, serverTransport } = await connectClient();

    const result = await callToolWithToken(client, "getProjects", {});

    const text = (result as CallToolResult).content[0] as { text: string };
    expect((result as CallToolResult).isError).toBe(true);
    expect(text.text).toContain("HTTP 400");

    await Promise.all([
      client.close(),
      clientTransport.close(),
      serverTransport.close(),
      server.close(),
    ]);
  });

  test("normalizes rich text wrappers and removes links.self noise", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [{
          id: "PRJ",
          type: "projects",
          attributes: {
            description: {
              type: "text/plain",
              value: "Sandbox project",
            },
          },
          links: {
            self: "https://example.invalid/projects/PRJ",
            related: "https://example.invalid/projects/PRJ/related",
          },
        }],
        links: {
          self: "https://example.invalid/projects",
          next: "https://example.invalid/projects?page[number]=2",
        },
      }),
    );

    const { client, server, clientTransport, serverTransport } = await connectClient();

    const result = await callToolWithToken(client, "getProjects", {});

    expect(textPayload(result as CallToolResult)).toEqual({
      data: [{
        id: "PRJ",
        type: "projects",
        attributes: {
          description: "Sandbox project",
        },
        links: {
          related: "https://example.invalid/projects/PRJ/related",
        },
      }],
      links: {
        next: "https://example.invalid/projects?page[number]=2",
      },
    });

    await Promise.all([
      client.close(),
      clientTransport.close(),
      serverTransport.close(),
      server.close(),
    ]);
  });

  test("includes item-limit truncation metadata in tool responses", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [
          { id: "1", type: "projects" },
          { id: "2", type: "projects" },
          { id: "3", type: "projects" },
        ],
        links: {},
      }),
    );

    const { client, server, clientTransport, serverTransport } = await connectClient();

    const result = await callToolWithToken(client, "getProjects", {
      page: { size: 2 },
    });

    expect(textPayload(result as CallToolResult)).toMatchObject({
      data: [
        { id: "1", type: "projects" },
        { id: "2", type: "projects" },
      ],
      truncation: {
        reason: "item_limit",
        original_item_count: 3,
        returned_item_count: 2,
        max_items: 2,
        max_chars: 16384,
        hint: "Use page_number and page_size to fetch the next slice.",
      },
    });

    await Promise.all([
      client.close(),
      clientTransport.close(),
      serverTransport.close(),
      server.close(),
    ]);
  });

  test("includes char-limit truncation metadata in tool responses", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [
          { id: "1", type: "projects", attributes: { description: "a".repeat(10_000) } },
          { id: "2", type: "projects", attributes: { description: "b".repeat(10_000) } },
        ],
        links: {},
      }),
    );

    const { client, server, clientTransport, serverTransport } = await connectClient();

    const result = await callToolWithToken(client, "getProjects", {});
    const payload = textPayload(result as CallToolResult);

    expect(payload.truncation).toMatchObject({
      reason: "char_limit",
      original_item_count: 2,
      returned_item_count: 1,
      max_items: 20,
      max_chars: 16384,
    });
    expect(payload.data).toHaveLength(1);

    await Promise.all([
      client.close(),
      clientTransport.close(),
      serverTransport.close(),
      server.close(),
    ]);
  });
});
