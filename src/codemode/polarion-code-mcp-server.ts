// Adapted from @cloudflare/codemode 0.3.3 dist/mcp.js.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  CompatibilityCallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { Executor } from "npm:@cloudflare/codemode";
import { z } from "zod";
import type { RequestContextLike } from "../helpers.ts";
import { runWithPolarionAccessToken } from "../request-context.ts";
import { generateTypesFromJsonSchema, sanitizeToolName } from "./json-schema-types.ts";

const CHARS_PER_TOKEN = 4;
const MAX_TOKENS = 6_000;
const MAX_CHARS = MAX_TOKENS * CHARS_PER_TOKEN;

function truncateResponse(content: unknown) {
  const text = typeof content === "string"
    ? content
    : JSON.stringify(content, null, 2) ?? "undefined";
  if (text.length <= MAX_CHARS) return text;
  return `${text.slice(0, MAX_CHARS)}\n\n--- TRUNCATED ---\nResponse was ~${
    Math.ceil(text.length / CHARS_PER_TOKEN).toLocaleString()
  } tokens (limit: ${MAX_TOKENS.toLocaleString()}). Use more specific queries to reduce response size.`;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function unwrapMcpResult(result: CallToolResult | CompatibilityCallToolResult): unknown {
  if ("toolResult" in result) return result.toolResult;
  if (result.isError) {
    const message = result.content
      .filter((content) => content.type === "text")
      .map((content) => ("text" in content ? content.text : ""))
      .join("\n") || "Tool call failed";
    throw new Error(message);
  }
  if (result.structuredContent != null) return result.structuredContent;
  if (result.content.length > 0 && result.content.every((content) => content.type === "text")) {
    const text = result.content.map((content) => ("text" in content ? content.text : "")).join(
      "\n",
    );
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return result;
}

const CODE_DESCRIPTION = `Execute code to achieve a goal.

Available:
{{types}}

Write an async arrow function in JavaScript that returns the result.
Do NOT use TypeScript syntax - no type annotations, interfaces, or generics.
Do NOT define named functions then call them - just write the arrow function body directly.

{{example}}`;

function resolveEntryAuthToken(extra: RequestContextLike): string | undefined {
  return extra.authInfo?.token ?? Deno.env.get("POLARION_ACCESS_TOKEN");
}

export async function createPolarionCodeMcpServer(options: {
  server: McpServer;
  executor: Executor;
  name?: string;
  version?: string;
  instructions?: string;
}) {
  const { server, executor, name = "polarion-mcp", version = "0.2.0", instructions } = options;

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({
    name: "codemode-proxy",
    version: "1.0.0",
  });
  await client.connect(clientTransport);

  const { tools } = await client.listTools();
  const toolDescriptors = Object.fromEntries(
    tools.map((tool) => [
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
    ]),
  );

  const types = generateTypesFromJsonSchema(toolDescriptors);
  const fns = Object.fromEntries(
    tools.map((tool) => [
      tool.name,
      async (args: unknown) =>
        unwrapMcpResult(
          await client.callTool({
            name: tool.name,
            arguments:
              args && typeof args === "object" && !Array.isArray(args)
                ? args as Record<string, unknown>
                : {},
          }) as CallToolResult | CompatibilityCallToolResult,
        ),
    ]),
  );

  const firstTool = tools[0];
  let example = "";
  if (firstTool) {
    const props = (firstTool.inputSchema.properties ?? {}) as Record<string, { type?: string }>;
    const parts: string[] = [];
    for (const [key, prop] of Object.entries(props)) {
      if (prop.type === "number" || prop.type === "integer") parts.push(`${key}: 0`);
      else if (prop.type === "boolean") parts.push(`${key}: true`);
      else parts.push(`${key}: "..."`);
    }
    const args = parts.length > 0 ? `{ ${parts.join(", ")} }` : "{}";
    example = `Example: async () => { const r = await codemode.${
      sanitizeToolName(firstTool.name)
    }(${args}); return r; }`;
  }

  const description = CODE_DESCRIPTION.replace("{{types}}", types).replace("{{example}}", example);
  const codemodeServer = new McpServer(
    {
      name,
      version,
    },
    instructions ? { instructions } : undefined,
  );

  codemodeServer.registerTool(
    "code",
    {
      description,
      inputSchema: {
        code: z.string().describe("JavaScript async arrow function to execute"),
      },
    },
    async ({ code }, extra) => {
      try {
        const result = await runWithPolarionAccessToken(
          resolveEntryAuthToken(extra),
          async () =>
            await executor.execute(code, [
              {
                name: "codemode",
                fns,
              },
            ]),
        );

        if (result.error) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: ${result.error}`,
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: truncateResponse(result.result),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${formatError(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  const originalClose = codemodeServer.close.bind(codemodeServer);
  codemodeServer.close = async () => {
    await Promise.allSettled([
      client.close(),
      server.close(),
    ]);
    return await originalClose();
  };

  return codemodeServer;
}
