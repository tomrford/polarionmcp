import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_INSTRUCTIONS } from "./instructions.ts";
import { registerProjectsTools } from "./tools/curated/projects.ts";
import { registerWorkItemTools } from "./tools/curated/work-items.ts";
import { registerDocumentTools } from "./tools/curated/documents.ts";
import { registerMetadataTools } from "./tools/curated/metadata.ts";
import { registerApiHelpTool } from "./tools/api-help.ts";
import { registerGenericReadTool } from "./tools/generic-read.ts";
import { registerResources } from "./resources.ts";
import { registerCommentTools } from "./tools/comments.ts";
import { registerLinkTools } from "./tools/links.ts";

export function registerServerFeatures(server: McpServer) {
  registerProjectsTools(server);
  registerWorkItemTools(server);
  registerDocumentTools(server);
  registerMetadataTools(server);
  registerApiHelpTool(server);
  registerGenericReadTool(server);
  registerCommentTools(server);
  registerLinkTools(server);
  registerResources(server);
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
