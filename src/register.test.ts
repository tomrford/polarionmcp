import { describe, test, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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
      "get_document",
      "get_enum_options",
      "get_fields_metadata",
      "get_work_item",
      "get_workflow_actions",
      "list_documents",
      "list_linked_work_items",
      "list_projects",
      "list_work_items",
      "update_work_item",
    ]);

    expect(client.getInstructions()).toContain("Polarion MCP usage rules");

    await Promise.all([
      client.close(),
      server.close(),
    ]);
  });
});
