import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  CompatibilityCallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { codeMcpServer } from "npm:@cloudflare/codemode/mcp";
import type { Executor } from "npm:@cloudflare/codemode";
import { PUBLIC_CODE_TOOL_DESCRIPTION, PUBLIC_SERVER_INSTRUCTIONS } from "./instructions.ts";
import type { RequestContextLike } from "./helpers.ts";
import { runWithPolarionAccessToken } from "./request-context.ts";
import { createServer as createInternalToolServer } from "./register.ts";
import { DenoSubprocessExecutor } from "./codemode/deno-executor.ts";

function resolveEntryAuthToken(extra: RequestContextLike): string | undefined {
  return extra.authInfo?.token ?? Deno.env.get("POLARION_ACCESS_TOKEN");
}

export async function createPublicServer(
  executor: Executor = new DenoSubprocessExecutor(),
) {
  const internalServer = createInternalToolServer();
  const wrappedServer = await codeMcpServer({
    server: internalServer,
    executor,
  });

  const proxyClient = new Client({
    name: "polarion-codemode-proxy",
    version: "1.0.0",
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    proxyClient.connect(clientTransport),
    wrappedServer.connect(serverTransport),
  ]);

  const publicServer = new McpServer(
    {
      name: "polarion-mcp",
      version: "0.2.0",
    },
    {
      instructions: PUBLIC_SERVER_INSTRUCTIONS,
    },
  );

  publicServer.registerTool(
    "code",
    {
      description: PUBLIC_CODE_TOOL_DESCRIPTION,
      inputSchema: {
        code: z.string().describe("JavaScript async arrow function to execute"),
      },
    },
    async ({ code }, extra) => {
      const result = await runWithPolarionAccessToken(
        resolveEntryAuthToken(extra),
        async () =>
          await proxyClient.callTool({
            name: "code",
            arguments: { code },
          }) as CallToolResult | CompatibilityCallToolResult,
      );

      if ("content" in result) return result as CallToolResult;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result.toolResult, null, 2),
          },
        ],
      } satisfies CallToolResult;
    },
  );

  const originalClose = publicServer.close.bind(publicServer);
  publicServer.close = async () => {
    await Promise.allSettled([
      proxyClient.close(),
      wrappedServer.close(),
      internalServer.close(),
    ]);
    return await originalClose();
  };

  return publicServer;
}
