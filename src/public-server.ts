import type { Executor } from "npm:@cloudflare/codemode";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolveAccessToken } from "./helpers.ts";
import {
  appendCustomGuidancePointer,
  readCustomInstructions,
  registerGuidelinesTool,
} from "./custom-instructions.ts";
import { DIRECT_SERVER_INSTRUCTIONS, PUBLIC_SERVER_INSTRUCTIONS } from "./instructions.ts";
import { createServer as createInternalToolServer } from "./register.ts";
import { registerGeneratedTools } from "./generated/register-generated-tools.ts";
import { DenoSubprocessExecutor } from "./codemode/deno-executor.ts";
import { createPolarionCodeMcpServer } from "./codemode/polarion-code-mcp-server.ts";
import { registerAttachmentTool } from "./attachments.ts";

export type { ResolveAccessToken };

export async function createPublicServer(options: {
  resolveAccessToken: ResolveAccessToken;
  executor?: Executor;
  codeMode?: boolean;
}) {
  const { resolveAccessToken, codeMode = true } = options;
  const customInstructions = await readCustomInstructions();

  if (!codeMode) {
    return createDirectPublicServer({ resolveAccessToken, customInstructions });
  }

  const internalServer = createInternalToolServer();
  return await createPolarionCodeMcpServer({
    server: internalServer,
    executor: options.executor ?? new DenoSubprocessExecutor(),
    instructions: customInstructions
      ? appendCustomGuidancePointer(PUBLIC_SERVER_INSTRUCTIONS)
      : PUBLIC_SERVER_INSTRUCTIONS,
    customInstructions,
    resolveAccessToken,
  });
}

function createDirectPublicServer(options: {
  resolveAccessToken: ResolveAccessToken;
  customInstructions?: string;
}) {
  const { resolveAccessToken, customInstructions } = options;
  const server = new McpServer(
    {
      name: "polarion-mcp",
      version: "0.2.0",
    },
    {
      instructions: customInstructions
        ? appendCustomGuidancePointer(DIRECT_SERVER_INSTRUCTIONS)
        : DIRECT_SERVER_INSTRUCTIONS,
    },
  );

  registerGeneratedTools(server, { resolveAccessToken });
  if (customInstructions) {
    registerGuidelinesTool(server, customInstructions);
  }
  registerAttachmentTool(server, { resolveAccessToken });
  return server;
}
