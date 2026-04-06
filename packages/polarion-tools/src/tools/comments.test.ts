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

describe("comment tools", () => {
  let postSpy: ReturnType<typeof vi.spyOn<typeof polarionClient, "POST">>;

  beforeEach(() => {
    postSpy = vi.spyOn(polarionClient, "POST");
    postSpy.mockReset();
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

  test("add_work_item_comment shapes JSON:API request body", async () => {
    postSpy.mockResolvedValueOnce({
      data: {
        data: [{ id: "PRJ/REQ-1/COMMENT-1", type: "workitem_comments" }],
      },
      response: { ok: true, status: 201 },
    } as unknown as any);

    const { client, server, clientTransport, serverTransport } = await connectClient();

    const result = await client.callTool({
      name: "add_work_item_comment",
      arguments: {
        project: "PRJ",
        work_item_id: "REQ-1",
        text: "Looks good",
        text_type: "text/plain",
      },
    });

    expectCalledWith(postSpy, "/projects/{projectId}/workitems/{workItemId}/comments", {
      headers: { Authorization: "Bearer test-token" },
      params: {
        path: { projectId: "PRJ", workItemId: "REQ-1" },
      },
      body: {
        data: [
          {
            type: "workitem_comments",
            attributes: {
              text: {
                type: "text/plain",
                value: "Looks good",
              },
            },
          },
        ],
      },
    });

    expect(textPayload(result)).toEqual({
      created: true,
      comment_id: "PRJ/REQ-1/COMMENT-1",
      work_item: "PRJ/REQ-1",
    });

    await clientTransport.close();
    await serverTransport.close();
    await server.close();
  });
});
