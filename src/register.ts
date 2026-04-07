import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_INSTRUCTIONS } from "./instructions.ts";
import { registerGeneratedTools } from "./generated/register-generated-tools.ts";

export function registerServerFeatures(server: McpServer) {
  registerGeneratedTools(server);
}

export function createServer() {
  const server = new McpServer(
    {
      name: "polarion-mcp",
      version: "0.1.0",
    },
    {
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  registerServerFeatures(server);
  return server;
}
