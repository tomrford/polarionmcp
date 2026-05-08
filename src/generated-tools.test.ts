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
    Deno.env.delete("REST_PAGE_SIZE");
    Deno.env.delete("FETCH_CONCURRENCY_COUNT");
  });

  afterEach(() => {
    Deno.env.delete("REST_PAGE_SIZE");
    Deno.env.delete("FETCH_CONCURRENCY_COUNT");
    vi.restoreAllMocks();
  });

  async function connectClient() {
    const server = createServer();
    const client = new Client({
      name: "test-client",
      version: "1.0.0",
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    return { client, server, clientTransport, serverTransport };
  }

  async function callToolWithToken(
    client: Client,
    name: string,
    args: Record<string, unknown>,
    authToken = "token",
  ) {
    return await runWithPolarionAccessToken(
      authToken,
      async () =>
        await client.callTool({
          name,
          arguments: args,
        }),
    );
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
    });

    const [url, init] = fetchSpy.calls[0]!.args as [string, RequestInit];
    expect(url).toBe("https://example.invalid/projects?query=id%3APRJ*");
    expect(init.headers).toEqual({
      Accept: "application/json",
      Authorization: "Bearer token",
    });

    expect(textPayload(result as CallToolResult)).toMatchObject({
      kind: "collection",
      items: [{ id: "PRJ", type: "projects" }],
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
      kind: "resource",
      item: { type: "fieldsmetadata" },
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

  test("404 errors include a short not-found hint", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("missing", { status: 404, headers: { "content-type": "text/plain" } }),
    );

    const { client, server, clientTransport, serverTransport } = await connectClient();

    const result = await callToolWithToken(client, "getProjects", {});
    const payload = textPayload(result as CallToolResult);

    expect((result as CallToolResult).isError).toBe(true);
    expect(payload).toMatchObject({
      status_code: 404,
      suggestion: "Not found at this path.",
    });

    await Promise.all([
      client.close(),
      clientTransport.close(),
      serverTransport.close(),
      server.close(),
    ]);
  });

  test("403 errors include a short escalation hint", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("forbidden", { status: 403, headers: { "content-type": "text/plain" } }),
    );

    const { client, server, clientTransport, serverTransport } = await connectClient();

    const result = await callToolWithToken(client, "getProjects", {});
    const payload = textPayload(result as CallToolResult);

    expect((result as CallToolResult).isError).toBe(true);
    expect(payload).toMatchObject({
      status_code: 403,
      suggestion: "Access denied. User action required.",
    });

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
        data: [
          {
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
          },
        ],
        links: {
          self: "https://example.invalid/projects",
        },
        meta: { totalCount: 1 },
      }),
    );

    const { client, server, clientTransport, serverTransport } = await connectClient();

    const result = await callToolWithToken(client, "getProjects", {});
    const payload = textPayload(result as CallToolResult);

    expect(payload.kind).toBe("collection");
    expect(payload.items).toEqual([
      {
        id: "PRJ",
        type: "projects",
        attributes: {
          description: "Sandbox project",
        },
        links: {
          related: "https://example.invalid/projects/PRJ/related",
        },
      },
    ]);
    expect(payload.links).toBeUndefined();

    await Promise.all([
      client.close(),
      clientTransport.close(),
      serverTransport.close(),
      server.close(),
    ]);
  });

  test("rejects page controls in generated tool input", async () => {
    const { client, server, clientTransport, serverTransport } = await connectClient();

    const result = await callToolWithToken(client, "getProjects", { page: { size: 5, number: 2 } });

    expect((result as CallToolResult).isError).toBe(true);
    expect(((result as CallToolResult).content[0] as { text: string }).text).toContain("page");

    await Promise.all([
      client.close(),
      clientTransport.close(),
      serverTransport.close(),
      server.close(),
    ]);
  });

  test("fetches collection pages by page number and returns the full collection", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [
          { id: "1", type: "projects" },
          { id: "2", type: "projects" },
        ],
        links: {
          next: "https://example.invalid/projects?page[number]=2",
        },
        meta: { totalCount: 5 },
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [
          { id: "3", type: "projects" },
          { id: "4", type: "projects" },
        ],
        links: {},
        meta: { totalCount: 5 },
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [{ id: "5", type: "projects" }],
        links: {},
        meta: { totalCount: 5 },
      }),
    );

    const { client, server, clientTransport, serverTransport } = await connectClient();

    const result = await callToolWithToken(client, "getProjects", {});

    expect(textPayload(result as CallToolResult)).toMatchObject({
      kind: "collection",
      items: [
        { id: "1", type: "projects" },
        { id: "2", type: "projects" },
        { id: "3", type: "projects" },
        { id: "4", type: "projects" },
        { id: "5", type: "projects" },
      ],
      meta: { totalCount: 5 },
    });
    expect(fetchSpy.calls).toHaveLength(3);
    expect(fetchSpy.calls[1]!.args[0]).toBe("https://example.invalid/projects?page%5Bnumber%5D=2");
    expect(fetchSpy.calls[2]!.args[0]).toBe("https://example.invalid/projects?page%5Bnumber%5D=3");

    await Promise.all([
      client.close(),
      clientTransport.close(),
      serverTransport.close(),
      server.close(),
    ]);
  });

  test("uses REST_PAGE_SIZE on the first request", async () => {
    Deno.env.set("REST_PAGE_SIZE", "250");
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [{ id: "1", type: "projects" }],
        links: {},
        meta: { totalCount: 1 },
      }),
    );

    const { client, server, clientTransport, serverTransport } = await connectClient();

    const result = await callToolWithToken(client, "getProjects", {});

    expect(textPayload(result as CallToolResult)).toMatchObject({
      kind: "collection",
      items: [{ id: "1", type: "projects" }],
    });
    expect(fetchSpy.calls).toHaveLength(1);
    expect(fetchSpy.calls[0]!.args[0]).toBe("https://example.invalid/projects?page%5Bsize%5D=250");

    await Promise.all([
      client.close(),
      clientTransport.close(),
      serverTransport.close(),
      server.close(),
    ]);
  });

  test("fetches follow-up pages in concurrency-sized batches", async () => {
    Deno.env.set("FETCH_CONCURRENCY_COUNT", "2");
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [
          { id: "1", type: "projects" },
          { id: "2", type: "projects" },
        ],
        links: {},
        meta: { totalCount: 7 },
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [
          { id: "3", type: "projects" },
          { id: "4", type: "projects" },
        ],
        links: {},
        meta: { totalCount: 7 },
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [
          { id: "5", type: "projects" },
          { id: "6", type: "projects" },
        ],
        links: {},
        meta: { totalCount: 7 },
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [{ id: "7", type: "projects" }],
        links: {},
        meta: { totalCount: 7 },
      }),
    );

    const { client, server, clientTransport, serverTransport } = await connectClient();

    const result = await callToolWithToken(client, "getProjects", {});

    expect(textPayload(result as CallToolResult)).toMatchObject({
      kind: "collection",
      items: [
        { id: "1", type: "projects" },
        { id: "2", type: "projects" },
        { id: "3", type: "projects" },
        { id: "4", type: "projects" },
        { id: "5", type: "projects" },
        { id: "6", type: "projects" },
        { id: "7", type: "projects" },
      ],
      meta: { totalCount: 7 },
    });
    expect(fetchSpy.calls).toHaveLength(4);
    expect(fetchSpy.calls.slice(1).map((call) => call.args[0])).toEqual([
      "https://example.invalid/projects?page%5Bnumber%5D=2",
      "https://example.invalid/projects?page%5Bnumber%5D=3",
      "https://example.invalid/projects?page%5Bnumber%5D=4",
    ]);

    await Promise.all([
      client.close(),
      clientTransport.close(),
      serverTransport.close(),
      server.close(),
    ]);
  });

  test("errors when a follow-up page returns non-JSON content", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [{ id: "1", type: "projects" }],
        links: {
          next: "https://example.invalid/projects?page[number]=2",
        },
        meta: { totalCount: 2 },
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response("<html>login</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    const { client, server, clientTransport, serverTransport } = await connectClient();

    const result = await callToolWithToken(client, "getProjects", {});

    expect((result as CallToolResult).isError).toBe(true);
    expect(textPayload(result as CallToolResult)).toMatchObject({
      error: true,
      status_code: 409,
      message: "Polarion pagination returned non-JSON content",
    });
    expect(fetchSpy.calls).toHaveLength(2);

    await Promise.all([
      client.close(),
      clientTransport.close(),
      serverTransport.close(),
      server.close(),
    ]);
  });

  test("errors when meta.totalCount exceeds the returned collection size", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [
          { id: "1", type: "projects" },
          { id: "2", type: "projects" },
        ],
        links: {},
        meta: { totalCount: 3 },
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [],
        links: {},
        meta: { totalCount: 3 },
      }),
    );

    const { client, server, clientTransport, serverTransport } = await connectClient();

    const result = await callToolWithToken(client, "getProjects", {});

    expect((result as CallToolResult).isError).toBe(true);
    expect(
      JSON.parse(((result as CallToolResult).content[0] as { text: string }).text),
    ).toMatchObject({
      error: true,
      status_code: 409,
      message: "Polarion returned a partial collection",
    });

    await Promise.all([
      client.close(),
      clientTransport.close(),
      serverTransport.close(),
      server.close(),
    ]);
  });

  test("errors when auto-paginated collection omits totalCount", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [{ id: "1", type: "projects" }],
        links: {},
        meta: {},
      }),
    );

    const { client, server, clientTransport, serverTransport } = await connectClient();

    const result = await callToolWithToken(client, "getProjects", {});

    expect((result as CallToolResult).isError).toBe(true);
    expect(textPayload(result as CallToolResult)).toMatchObject({
      error: true,
      status_code: 409,
      message: "Polarion pagination did not return totalCount",
    });

    await Promise.all([
      client.close(),
      clientTransport.close(),
      serverTransport.close(),
      server.close(),
    ]);
  });
});
