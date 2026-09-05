import { McpServer } from "@modelcontextprotocol/server";
import { polarionConfig } from "./config";
import { registerAttachmentTool } from "./attachments";
import { registerGeneratedTools } from "./generated/register-generated-tools";
import { registerCodeTool } from "./tools/code";
import { registerSearchTool } from "./tools/search";

export const SERVER_INFO = {
  name: "polarion-mcp",
  version: "0.2.0",
};

export function createServer(codemode = true): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: polarionConfig().guidelines });
  registerAttachmentTool(server);
  if (codemode) {
    registerSearchTool(server);
    registerCodeTool(server);
    return server;
  }
  registerGeneratedTools(server);
  return server;
}
