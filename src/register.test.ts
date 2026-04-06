import { describe, expect, test } from "./test/test.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "./register.ts";

describe("createServer", () => {
  test("registers current curated tools and exposes instructions", async () => {
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

    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name).sort();

    expect(toolNames).toEqual([
      "add_work_item_comment",
      "add_work_item_link",
      "get_document",
      "get_enum_options",
      "get_fields_metadata",
      "get_work_item",
      "get_workflow_actions",
      "list_documents",
      "list_linked_work_items",
      "list_projects",
      "list_work_items",
      "polarion_api_help",
      "polarion_api_read",
      "remove_work_item_link",
      "update_work_item",
      "update_work_item_link",
    ]);

    expect(client.getInstructions()).toContain("Polarion tool-surface rules");

    let error: unknown;
    try {
      await client.listResources();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(-32601);

    await Promise.all([
      client.close(),
      server.close(),
    ]);
  });
});
