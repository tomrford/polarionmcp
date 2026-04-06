import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectCalledWith,
  test,
  vi,
} from "../test/test.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../register.ts";
import { client as polarionClient } from "../client.ts";

const clientInfo = {
  name: "polarion-test-client",
  version: "1.0.0",
} as const;

describe("link tools", () => {
  let postSpy: ReturnType<typeof vi.spyOn<typeof polarionClient, "POST">>;
  let patchSpy: ReturnType<typeof vi.spyOn<typeof polarionClient, "PATCH">>;
  let deleteSpy: ReturnType<typeof vi.spyOn<typeof polarionClient, "DELETE">>;

  beforeEach(() => {
    postSpy = vi.spyOn(polarionClient, "POST");
    patchSpy = vi.spyOn(polarionClient, "PATCH");
    deleteSpy = vi.spyOn(polarionClient, "DELETE");
    postSpy.mockReset();
    patchSpy.mockReset();
    deleteSpy.mockReset();
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

  test("add_work_item_link shapes POST request", async () => {
    postSpy.mockResolvedValueOnce({
      data: {
        data: [{ id: "PRJ/REQ-1/relates_to/PRJ/REQ-2" }],
      },
      response: { ok: true, status: 201 },
    } as unknown as any);

    const { client, server, clientTransport, serverTransport } = await connectClient();

    const result = await client.callTool({
      name: "add_work_item_link",
      arguments: {
        project: "PRJ",
        work_item_id: "REQ-1",
        target_project: "PRJ",
        target_work_item_id: "REQ-2",
        role: "relates_to",
        suspect: true,
      },
    });

    expectCalledWith(postSpy, "/projects/{projectId}/workitems/{workItemId}/linkedworkitems", {
      headers: { Authorization: "Bearer test-token" },
      params: {
        path: { projectId: "PRJ", workItemId: "REQ-1" },
      },
      body: {
        data: [
          {
            type: "linkedworkitems",
            attributes: {
              role: "relates_to",
              suspect: true,
            },
            relationships: {
              workItem: {
                data: {
                  type: "workitems",
                  id: "PRJ/REQ-2",
                },
              },
            },
          },
        ],
      },
    });

    expect(textPayload(result)).toEqual({
      created: true,
      link_id: "PRJ/REQ-1/relates_to/PRJ/REQ-2",
    });

    await clientTransport.close();
    await serverTransport.close();
    await server.close();
  });

  test("update_work_item_link shapes PATCH request", async () => {
    patchSpy.mockResolvedValueOnce({
      response: { ok: true, status: 204 },
    } as unknown as any);

    const { client, server, clientTransport, serverTransport } = await connectClient();

    const result = await client.callTool({
      name: "update_work_item_link",
      arguments: {
        project: "PRJ",
        work_item_id: "REQ-1",
        target_project: "PRJ",
        target_work_item_id: "REQ-2",
        role: "relates_to",
        suspect: false,
      },
    });

    expectCalledWith(
      patchSpy,
      "/projects/{projectId}/workitems/{workItemId}/linkedworkitems/{roleId}/{targetProjectId}/{linkedWorkItemId}",
      {
        headers: { Authorization: "Bearer test-token" },
        params: {
          path: {
            projectId: "PRJ",
            workItemId: "REQ-1",
            roleId: "relates_to",
            targetProjectId: "PRJ",
            linkedWorkItemId: "REQ-2",
          },
        },
        body: {
          data: {
            type: "linkedworkitems",
            id: "PRJ/REQ-1/relates_to/PRJ/REQ-2",
            attributes: {
              suspect: false,
            },
          },
        },
      },
    );

    expect(textPayload(result)).toEqual({
      updated: true,
      suspect: false,
    });

    await clientTransport.close();
    await serverTransport.close();
    await server.close();
  });

  test("remove_work_item_link shapes DELETE request", async () => {
    deleteSpy.mockResolvedValueOnce({
      response: { ok: true, status: 204 },
    } as unknown as any);

    const { client, server, clientTransport, serverTransport } = await connectClient();

    const result = await client.callTool({
      name: "remove_work_item_link",
      arguments: {
        project: "PRJ",
        work_item_id: "REQ-1",
        target_project: "PRJ",
        target_work_item_id: "REQ-2",
        role: "relates_to",
      },
    });

    expectCalledWith(
      deleteSpy,
      "/projects/{projectId}/workitems/{workItemId}/linkedworkitems/{roleId}/{targetProjectId}/{linkedWorkItemId}",
      {
        headers: { Authorization: "Bearer test-token" },
        params: {
          path: {
            projectId: "PRJ",
            workItemId: "REQ-1",
            roleId: "relates_to",
            targetProjectId: "PRJ",
            linkedWorkItemId: "REQ-2",
          },
        },
      },
    );

    expect(textPayload(result)).toEqual({
      removed: true,
    });

    await clientTransport.close();
    await serverTransport.close();
    await server.close();
  });
});
