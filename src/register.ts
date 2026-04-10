import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerGeneratedTools } from "./generated/register-generated-tools.ts";

export function registerServerFeatures(server: McpServer) {
  registerGeneratedTools(server);
}

export function createServer() {
  const server = new McpServer({
    name: "polarion-mcp",
    version: "0.1.0",
  });

  registerServerFeatures(server);
  return server;
}
