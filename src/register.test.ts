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

    expect(client.getInstructions()).toContain("Polarion MCP usage rules");

    await Promise.all([
      client.close(),
      server.close(),
    ]);
  });

  test("registers guide resources", async () => {
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

    const resources = await client.listResources();
    const resourceUris = resources.resources.map((resource) => resource.uri).sort();

    expect(resourceUris).toEqual([
      "polarion://guides/mcp-usage",
      "polarion://guides/query-syntax",
    ]);

    const usageGuide = await client.readResource({
      uri: "polarion://guides/mcp-usage",
    });

    expect(usageGuide.contents[0]?.uri).toBe("polarion://guides/mcp-usage");
    expect("text" in usageGuide.contents[0]!).toBe(true);

    await Promise.all([
      client.close(),
      server.close(),
    ]);
  });
});
