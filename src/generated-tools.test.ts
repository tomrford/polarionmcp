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
    });

    const [url, init] = fetchSpy.calls[0]!.args as [string, RequestInit];
    expect(url).toBe("https://example.invalid/projects?query=id%3APRJ*");
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
        },
      }),
    );

    const { client, server, clientTransport, serverTransport } = await connectClient();

    const result = await callToolWithToken(client, "getProjects", {});
    const payload = textPayload(result as CallToolResult);

    expect(payload.data).toEqual([{
      id: "PRJ",
      type: "projects",
      attributes: {
        description: "Sandbox project",
      },
      links: {
        related: "https://example.invalid/projects/PRJ/related",
      },
    }]);
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

  test("walks Polarion pagination links and returns the full collection", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [
          { id: "1", type: "projects" },
          { id: "2", type: "projects" },
        ],
        links: {
          next: "https://example.invalid/projects?page[number]=2",
        },
        meta: { totalCount: 3 },
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [
          { id: "3", type: "projects" },
        ],
        links: {},
        meta: { totalCount: 3 },
      }),
    );

    const { client, server, clientTransport, serverTransport } = await connectClient();

    const result = await callToolWithToken(client, "getProjects", {});

    expect(textPayload(result as CallToolResult)).toMatchObject({
      data: [
        { id: "1", type: "projects" },
        { id: "2", type: "projects" },
        { id: "3", type: "projects" },
      ],
      meta: { totalCount: 3 },
    });
    expect(fetchSpy.calls).toHaveLength(2);
    expect(fetchSpy.calls[1]!.args[0]).toBe("https://example.invalid/projects?page[number]=2");

    await Promise.all([
      client.close(),
      clientTransport.close(),
      serverTransport.close(),
      server.close(),
    ]);
  });

  test("rejects cross-origin pagination links before fetching follow-up pages", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [
          { id: "1", type: "projects" },
        ],
        links: {
          next: "https://evil.invalid/projects?page[number]=2",
        },
        meta: { totalCount: 2 },
      }),
    );

    const { client, server, clientTransport, serverTransport } = await connectClient();

    const result = await callToolWithToken(client, "getProjects", {});

    expect((result as CallToolResult).isError).toBe(true);
    expect(textPayload(result as CallToolResult)).toMatchObject({
      error: true,
      status_code: 409,
      message: "Polarion pagination returned a cross-origin next link",
    });
    expect(fetchSpy.calls).toHaveLength(1);

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
        data: [
          { id: "1", type: "projects" },
        ],
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

    const { client, server, clientTransport, serverTransport } = await connectClient();

    const result = await callToolWithToken(client, "getProjects", {});

    expect((result as CallToolResult).isError).toBe(true);
    expect(JSON.parse(((result as CallToolResult).content[0] as { text: string }).text))
      .toMatchObject({
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
});
