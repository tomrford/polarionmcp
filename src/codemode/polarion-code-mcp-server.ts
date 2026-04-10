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
import { PUBLIC_CODE_TOOL_DESCRIPTION } from "../instructions.ts";
import { runWithPolarionAccessToken } from "../request-context.ts";
import type { ResolveAccessToken } from "../public-server.ts";
import { sanitizeToolName } from "./json-schema-types.ts";

const CHARS_PER_TOKEN = 4;
const MAX_TOKENS = 6_000;
const MAX_CHARS = MAX_TOKENS * CHARS_PER_TOKEN;

function truncateResponse(content: unknown) {
  const text = typeof content === "string"
    ? content
    : JSON.stringify(content) ?? "undefined";
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

async function runWithResolvedAccessToken<T>(
  extra: RequestContextLike,
  resolveAccessToken: ResolveAccessToken,
  fn: () => Promise<T>,
): Promise<T> {
  const token = resolveAccessToken(extra);
  if (!token) throw new Error("No Polarion access token available");
  return await runWithPolarionAccessToken(token, fn);
}

type ToolCatalogEntry = {
  name: string;
  callable: string;
  description?: string;
  resource_group?: string;
  required_params: string[];
  optional_params: string[];
  input_summary?: string;
  output_summary?: string;
  annotations?: Record<string, unknown>;
  search_text: string;
  compact_text: string;
};

function schemaProperties(inputSchema: Record<string, unknown>): Record<string, unknown> {
  const properties = inputSchema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return {};
  return properties as Record<string, unknown>;
}

function schemaRequired(inputSchema: Record<string, unknown>): string[] {
  const required = inputSchema.required;
  if (!Array.isArray(required)) return [];
  return required.filter((value): value is string => typeof value === "string");
}

function schemaPropertyDescriptions(inputSchema: Record<string, unknown>): string[] {
  return Object.values(schemaProperties(inputSchema))
    .map((property) =>
      typeof property === "object" && property && "description" in property
        ? property.description
        : undefined
    )
    .filter((value): value is string => typeof value === "string");
}

function compactSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function stemSearchToken(value: string): string {
  if (value.length > 4 && value.endsWith("ies")) return `${value.slice(0, -3)}y`;
  if (value.length > 3 && value.endsWith("s")) return value.slice(0, -1);
  return value;
}

function buildToolCatalog(
  tools: Array<{
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
    annotations?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  }>,
) {
  const entries: ToolCatalogEntry[] = tools.map((tool) => {
    const required = new Set(schemaRequired(tool.inputSchema));
    const properties = schemaProperties(tool.inputSchema);
    const propertyDescriptions = schemaPropertyDescriptions(tool.inputSchema);
    const paramNames = Object.keys(properties);
    const resourceGroup = typeof tool._meta?.resourceGroup === "string"
      ? tool._meta.resourceGroup
      : undefined;
    const inputSummary = typeof tool._meta?.inputSummary === "string"
      ? tool._meta.inputSummary
      : undefined;
    const outputSummary = typeof tool._meta?.outputSummary === "string"
      ? tool._meta.outputSummary
      : undefined;
    const searchSource = [
      tool.name,
      sanitizeToolName(tool.name),
      tool.description ?? "",
      resourceGroup ?? "",
      inputSummary ?? "",
      outputSummary ?? "",
      ...paramNames,
      ...propertyDescriptions,
    ].join(" ");
    return {
      name: tool.name,
      callable: `codemode.${sanitizeToolName(tool.name)}`,
      description: tool.description,
      resource_group: resourceGroup,
      required_params: paramNames.filter((name) => required.has(name)),
      optional_params: paramNames.filter((name) => !required.has(name)),
      input_summary: inputSummary,
      output_summary: outputSummary,
      annotations: tool.annotations,
      search_text: normalizeSearchText(searchSource),
      compact_text: compactSearchText(searchSource),
    };
  });

  return { entries };
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function searchCatalog(entries: ToolCatalogEntry[], query: string, limit: number) {
  const normalizedQuery = normalizeSearchText(query);
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  const normalizedNameCache = new Map<string, string>();
  const normalizedCallableCache = new Map<string, string>();
  const compactQuery = compactSearchText(query);
  const compactTokens = compactQuery.match(/[a-z0-9]+/g) ?? [];

  const scored = entries
    .map((entry) => {
      let score = 0;
      const haystack = entry.search_text;
      const compactHaystack = entry.compact_text;
      const normalizedName = normalizedNameCache.get(entry.name) ?? normalizeSearchText(entry.name);
      normalizedNameCache.set(entry.name, normalizedName);
      const normalizedCallable = normalizedCallableCache.get(entry.callable) ??
        normalizeSearchText(entry.callable);
      normalizedCallableCache.set(entry.callable, normalizedCallable);
      if (haystack.includes(normalizedQuery)) score += 100;
      if (compactQuery && compactHaystack.includes(compactQuery)) score += 90;
      if (normalizedName === normalizedQuery) score += 120;
      if (normalizedCallable.includes(normalizedQuery)) score += 80;
      for (const token of tokens) {
        const stemmedToken = stemSearchToken(token);
        if (normalizedName.includes(token) || normalizedName.includes(stemmedToken)) score += 30;
        if (
          normalizedCallable.includes(token) || normalizedCallable.includes(stemmedToken)
        ) score += 20;
        if (haystack.includes(token)) score += 10;
      }
      for (const token of compactTokens) {
        const stemmedToken = stemSearchToken(token);
        if (compactHaystack.includes(token) || compactHaystack.includes(stemmedToken)) score += 12;
      }
      return { entry, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));

  return {
    query,
    total_matches: scored.length,
    matches: scored.slice(0, limit).map(({ entry, score }) => ({
      name: entry.name,
      callable: entry.callable,
      resource_group: entry.resource_group,
      description: entry.description,
      required_params: entry.required_params,
      optional_params: entry.optional_params,
      input_summary: entry.input_summary,
      output_summary: entry.output_summary,
      annotations: entry.annotations,
      score,
    })),
  };
}

export async function createPolarionCodeMcpServer(options: {
  server: McpServer;
  executor: Executor;
  resolveAccessToken: ResolveAccessToken;
  name?: string;
  version?: string;
  instructions?: string;
}) {
  const {
    server,
    executor,
    resolveAccessToken,
    name = "polarion-mcp",
    version = "0.2.0",
    instructions,
  } = options;

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({
    name: "codemode-proxy",
    version: "1.0.0",
  });
  await client.connect(clientTransport);

  const { tools } = await client.listTools();
  const { entries } = buildToolCatalog(tools);
  const fns = Object.fromEntries(
    tools.map((tool) => [
      tool.name,
      async (args: unknown) =>
        unwrapMcpResult(
          await client.callTool({
            name: tool.name,
            arguments: args && typeof args === "object" && !Array.isArray(args)
              ? args as Record<string, unknown>
              : {},
          }) as CallToolResult | CompatibilityCallToolResult,
        ),
    ]),
  );
  const codemodeServer = new McpServer(
    {
      name,
      version,
    },
    instructions ? { instructions } : undefined,
  );

  codemodeServer.registerTool(
    "search",
    {
      description:
        "Fuzzy-search the Polarion code tool catalog by function name, partial name, route intent, or parameter name. Use this before code when you are unsure what to call.",
      inputSchema: {
        query: z
          .string()
          .describe("Partial tool name, route intent, or parameter keyword to search for"),
        limit: z.number().min(1).max(20).optional().default(8).describe(
          "Maximum matches to return",
        ),
      },
    },
    async ({ query, limit }, extra) => {
      try {
        return await runWithResolvedAccessToken(
          extra as RequestContextLike,
          resolveAccessToken,
          async () => ({
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(searchCatalog(entries, query, limit)),
              },
            ],
          }),
        );
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

  codemodeServer.registerTool(
    "code",
    {
      description: PUBLIC_CODE_TOOL_DESCRIPTION,
      inputSchema: {
        code: z.string().describe("JavaScript async arrow function to execute"),
      },
    },
    async ({ code }, extra) => {
      try {
        const result = await runWithResolvedAccessToken(
          extra as RequestContextLike,
          resolveAccessToken,
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
