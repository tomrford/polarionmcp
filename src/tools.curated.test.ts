import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectCalledWith,
  test,
  vi,
} from "./test/test.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./register.ts";
import { client as polarionClient } from "./client.ts";

type MockResponse<T> = {
  data?: T;
  error?: unknown;
  response: { ok: boolean; status: number };
};

const clientInfo = {
  name: "polarion-test-client",
  version: "1.0.0",
} as const;

describe("curated tools", () => {
  let getSpy: ReturnType<typeof vi.spyOn<typeof polarionClient, "GET">>;
  let patchSpy: ReturnType<typeof vi.spyOn<typeof polarionClient, "PATCH">>;

  beforeEach(() => {
    getSpy = vi.spyOn(polarionClient, "GET");
    patchSpy = vi.spyOn(polarionClient, "PATCH");
    getSpy.mockReset();
    patchSpy.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function connectClient(authToken = "test-token") {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    const client = new Client(clientInfo);

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const originalSend = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message, options) =>
      originalSend(message, {
        ...options,
        authInfo: { token: authToken, clientId: "test-client", scopes: [] },
      });

    return { client, server, clientTransport, serverTransport };
  }

  function textPayload(result: any) {
    const first = result.content[0];
    expect(first?.type).toBe("text");
    return JSON.parse((first as { text: string }).text);
  }

  test("list_projects shapes request and response", async () => {
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
      name: "list_projects",
      arguments: {
        query: "status:open",
        fields: "name",
        page_size: 10,
        page_number: 2,
      },
    });

    expectCalledWith(getSpy, "/projects", {
      headers: { Authorization: "Bearer test-token" },
      params: {
        query: {
          "page[size]": 10,
          "page[number]": 2,
          query: "status:open",
          fields: { projects: "name" },
        },
      },
    });

    expect(textPayload(result)).toEqual({
      items: [{ id: "PRJ", type: "projects", attributes: { name: "Project" } }],
      pagination: {
        total: 1,
        page_size: 10,
        page_number: 2,
        has_next: false,
      },
    });

    await clientTransport.close();
    await serverTransport.close();
    await server.close();
  });

  test("list_work_items forwards project filters and auth", async () => {
    getSpy.mockResolvedValueOnce({
      data: {
        data: [{ id: "PRJ/REQ-1", type: "workitems", attributes: { title: "Req" } }],
        meta: { totalCount: 1 },
        links: { next: "https://next" },
      },
      response: { ok: true, status: 200 },
    } as unknown as any);

    const { client, server, clientTransport, serverTransport } = await connectClient();

    const result = await client.callTool({
      name: "list_work_items",
      arguments: {
        project: "PRJ",
        query: "type:requirement",
        fields: "title,status",
        revision: "1234",
      },
    });

    expectCalledWith(getSpy, "/projects/{projectId}/workitems", {
      headers: { Authorization: "Bearer test-token" },
      params: {
        path: { projectId: "PRJ" },
        query: {
          "page[size]": 20,
          "page[number]": 1,
          query: "type:requirement",
          revision: "1234",
          fields: { workitems: "title,status" },
        },
      },
    });

    expect(textPayload(result)).toEqual({
      items: [{ id: "PRJ/REQ-1", type: "workitems", attributes: { title: "Req" } }],
      pagination: {
        total: 1,
        page_size: 20,
        page_number: 1,
        has_next: true,
      },
    });

    await clientTransport.close();
    await serverTransport.close();
    await server.close();
  });

  test("get_work_item returns full detail", async () => {
    getSpy.mockResolvedValueOnce({
      data: {
        data: {
          id: "PRJ/REQ-1",
          type: "workitems",
          attributes: { title: "Req", status: "open" },
        },
      },
      response: { ok: true, status: 200 },
    } as unknown as any);

    const { client, server, clientTransport, serverTransport } = await connectClient();

    const result = await client.callTool({
      name: "get_work_item",
      arguments: {
        project: "PRJ",
        work_item_id: "REQ-1",
        fields: "title,status",
      },
    });

    expectCalledWith(getSpy, "/projects/{projectId}/workitems/{workItemId}", {
      headers: { Authorization: "Bearer test-token" },
      params: {
        path: { projectId: "PRJ", workItemId: "REQ-1" },
        query: {
          revision: undefined,
          fields: { workitems: "title,status" },
        },
      },
    });

    expect(textPayload(result)).toEqual({
      id: "PRJ/REQ-1",
      type: "workitems",
      attributes: { title: "Req", status: "open" },
    });

    await clientTransport.close();
    await serverTransport.close();
    await server.close();
  });

  test("update_work_item shapes sparse patch request", async () => {
    patchSpy.mockResolvedValueOnce({
      response: { ok: true, status: 204 },
    } as unknown as any);

    const { client, server, clientTransport, serverTransport } = await connectClient();

    const result = await client.callTool({
      name: "update_work_item",
      arguments: {
        project: "PRJ",
        work_item_id: "REQ-1",
        attributes: { title: "Updated", status: "in_progress" },
        workflow_action: "start_progress",
        change_type_to: "defect",
      },
    });

    expectCalledWith(patchSpy, "/projects/{projectId}/workitems/{workItemId}", {
      headers: { Authorization: "Bearer test-token" },
      params: {
        path: { projectId: "PRJ", workItemId: "REQ-1" },
        query: {
          workflowAction: "start_progress",
          changeTypeTo: "defect",
        },
      },
      body: {
        data: {
          type: "workitems",
          id: "PRJ/REQ-1",
          attributes: { title: "Updated", status: "in_progress" },
        },
      },
    });

    expect(textPayload(result)).toEqual({ updated: "PRJ/REQ-1" });

    await clientTransport.close();
    await serverTransport.close();
    await server.close();
  });

  test("list_documents uses project-scoped pagination", async () => {
    getSpy.mockResolvedValueOnce({
      data: {
        data: [{ id: "PRJ/SPACE/DOC", type: "documents", attributes: { title: "Doc" } }],
        meta: { totalCount: 1 },
        links: {},
      },
      response: { ok: true, status: 200 },
    } as unknown as any);

    const { client, server, clientTransport, serverTransport } = await connectClient();

    const result = await client.callTool({
      name: "list_documents",
      arguments: {
        project: "PRJ",
        query: "title:Spec",
      },
    });

    expectCalledWith(getSpy, "/projects/{projectId}/documents", {
      headers: { Authorization: "Bearer test-token" },
      params: {
        path: { projectId: "PRJ" },
        query: {
          "page[size]": 20,
          "page[number]": 1,
          query: "title:Spec",
          fields: undefined,
        },
      },
    });

    expect(textPayload(result)).toEqual({
      items: [{ id: "PRJ/SPACE/DOC", type: "documents", attributes: { title: "Doc" } }],
      pagination: {
        total: 1,
        page_size: 20,
        page_number: 1,
        has_next: false,
      },
    });

    await clientTransport.close();
    await serverTransport.close();
    await server.close();
  });

  test("get_document fetches by space and name", async () => {
    getSpy.mockResolvedValueOnce({
      data: {
        data: {
          id: "PRJ/_default/Spec",
          type: "documents",
          attributes: { title: "Spec" },
        },
      },
      response: { ok: true, status: 200 },
    } as unknown as any);

    const { client, server, clientTransport, serverTransport } = await connectClient();

    const result = await client.callTool({
      name: "get_document",
      arguments: {
        project: "PRJ",
        space: "_default",
        document: "Spec",
      },
    });

    expectCalledWith(
      getSpy,
      "/projects/{projectId}/spaces/{spaceId}/documents/{documentName}",
      {
        headers: { Authorization: "Bearer test-token" },
        params: {
          path: { projectId: "PRJ", spaceId: "_default", documentName: "Spec" },
          query: {
            revision: undefined,
            fields: undefined,
          },
        },
      },
    );

    expect(textPayload(result)).toEqual({
      id: "PRJ/_default/Spec",
      type: "documents",
      attributes: { title: "Spec" },
    });

    await clientTransport.close();
    await serverTransport.close();
    await server.close();
  });

  test("list_linked_work_items returns outgoing links", async () => {
    getSpy.mockResolvedValueOnce({
      data: {
        data: [{
          id: "PRJ/REQ-1/relates_to/PRJ/REQ-2",
          type: "linkedworkitems",
          attributes: { role: "relates_to" },
        }],
        meta: { totalCount: 1 },
        links: {},
      },
      response: { ok: true, status: 200 },
    } as unknown as any);

    const { client, server, clientTransport, serverTransport } = await connectClient();

    const result = await client.callTool({
      name: "list_linked_work_items",
      arguments: {
        project: "PRJ",
        work_item_id: "REQ-1",
      },
    });

    expectCalledWith(getSpy, "/projects/{projectId}/workitems/{workItemId}/linkedworkitems", {
      headers: { Authorization: "Bearer test-token" },
      params: {
        path: { projectId: "PRJ", workItemId: "REQ-1" },
        query: {
          "page[size]": 20,
          "page[number]": 1,
          fields: undefined,
        },
      },
    });

    expect(textPayload(result)).toEqual({
      items: [{
        id: "PRJ/REQ-1/relates_to/PRJ/REQ-2",
        type: "linkedworkitems",
        attributes: { role: "relates_to" },
      }],
      pagination: {
        total: 1,
        page_size: 20,
        page_number: 1,
        has_next: false,
      },
    });

    await clientTransport.close();
    await serverTransport.close();
    await server.close();
  });

  test("get_fields_metadata passes resource and target type", async () => {
    getSpy.mockResolvedValueOnce({
      data: {
        data: {
          attributes: {
            fields: [{ id: "title" }, { id: "severity" }],
          },
        },
      },
      response: { ok: true, status: 200 },
    } as unknown as any);

    const { client, server, clientTransport, serverTransport } = await connectClient();

    const result = await client.callTool({
      name: "get_fields_metadata",
      arguments: {
        project: "PRJ",
        resource_type: "workitems",
        target_type: "requirement",
      },
    });

    expectCalledWith(getSpy, "/projects/{projectId}/actions/getFieldsMetadata", {
      headers: { Authorization: "Bearer test-token" },
      params: {
        path: { projectId: "PRJ" },
        query: { resourceType: "workitems", targetType: "requirement" },
      },
    });

    expect(textPayload(result)).toEqual({
      fields: [{ id: "title" }, { id: "severity" }],
    });

    await clientTransport.close();
    await serverTransport.close();
    await server.close();
  });

  test("tool errors surface structured HTTP errors", async () => {
    getSpy.mockResolvedValueOnce({
      error: { errors: [{ detail: "Bad token" }] },
      response: { ok: false, status: 401 },
    } as unknown as any);

    const { client, server, clientTransport, serverTransport } = await connectClient();

    const result = await client.callTool({
      name: "get_document",
      arguments: {
        project: "PRJ",
        space: "_default",
        document: "Spec",
      },
    });

    expect(result.isError).toBe(true);
    expect(textPayload(result)).toEqual({
      error: true,
      status_code: 401,
      message: "HTTP 401",
      details: JSON.stringify({ errors: [{ detail: "Bad token" }] }, null, 2),
    });

    await clientTransport.close();
    await serverTransport.close();
    await server.close();
  });
});
