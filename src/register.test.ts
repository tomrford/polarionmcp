import { describe, expect, test } from "./test/test.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "./register.ts";

describe("createServer", () => {
  test("registers generated operations and exposes raw-surface instructions", async () => {
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

    expect(toolNames).toContain("getProjects");
    expect(toolNames).toContain("getWorkItems");
    expect(toolNames).toContain("patchWorkItem");
    expect(toolNames).toContain("getProjectFieldsMetadata");
    expect(toolNames).toContain("executeJob");
    expect(toolNames).not.toContain("list_projects");
    expect(toolNames).not.toContain("polarion_api_help");
    expect(toolNames).not.toContain("polarion_api_read");

    expect(client.getInstructions()).toContain("generated Polarion operations");

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
