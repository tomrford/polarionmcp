import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, test, vi } from "./test/test.ts";
import { createServer } from "./register.ts";

describe("generated tools", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn<typeof globalThis, "fetch">>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function connectClient(authToken = "token") {
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

    const originalSend = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message, options) =>
      originalSend(message, {
        ...options,
        authInfo: { token: authToken, clientId: "test-client", scopes: [] },
      });

    return { client, server, clientTransport, serverTransport };
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

    const result = await client.callTool({
      name: "getProjects",
      arguments: {
        query: "id:PRJ*",
        page: { size: 5, number: 2 },
      },
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

    const result = await client.callTool({
      name: "patchWorkItem",
      arguments: {
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

    const result = await client.callTool({
      name: "getProjectFieldsMetadata",
      arguments: {
        projectId: "PRJ",
        resourceType: "workitems",
        targetType: "requirement",
      },
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

    const result = await client.callTool({
      name: "getProjects",
      arguments: {},
    });

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
});
