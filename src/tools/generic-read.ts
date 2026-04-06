import { z } from "zod/v4";
import { getPolarionBaseUrl } from "../client.ts";
import {
  authHeaders,
  errorResult,
  interpolatePath,
  ok,
  toQueryString,
  truncateResponse,
} from "../helpers.ts";
import { makeError, networkError } from "../errors.ts";
import { getResolvedReadOperations, resolveReadOperation } from "../openapi/read-policy.ts";
import { withToolLogging } from "../logging.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const MAX_RESPONSE_CHARS = 16_384;

function suggestOperationIds(operationId: string) {
  const lower = operationId.toLowerCase();
  return getResolvedReadOperations()
    .map(({ catalogEntry }) => catalogEntry.operationId)
    .filter((candidate) => candidate.toLowerCase().includes(lower.slice(0, 4)))
    .slice(0, 6);
}

function normalizePathParams(
  project: string | undefined,
  pathParams: Record<string, string> | undefined,
) {
  return {
    ...(pathParams ?? {}),
    ...(project ? { projectId: project } : {}),
  };
}

function validateQueryParams(
  allowedQueryParamNames: string[],
  query: Record<string, unknown> | undefined,
) {
  if (!query) return undefined;

  const allowed = new Set(allowedQueryParamNames);
  const invalid = Object.keys(query).filter((key) => !allowed.has(key));

  if (invalid.length > 0) {
    throw new Error(
      `Unsupported query parameter(s): ${invalid.join(", ")}. Allowed: ${
        allowedQueryParamNames.join(", ") || "none"
      }`,
    );
  }

  return query;
}

function readBaseUrl() {
  return getPolarionBaseUrl();
}

export function buildReadUrl(
  baseUrl: string,
  operation_id: string,
  project: string | undefined,
  path_params: Record<string, string> | undefined,
  query: Record<string, unknown> | undefined,
  scope_mode: "project" | "all",
  page_size: number,
  page_number: number,
) {
  const resolved = resolveReadOperation(operation_id);
  if (!resolved) {
    return {
      ok: false as const,
      error: makeError(
        400,
        `Unknown operation_id: ${operation_id}`,
        `Suggestions: ${suggestOperationIds(operation_id).join(", ") || "none"}`,
      ),
    };
  }

  const { catalogEntry, policy } = resolved;
  if (policy.mode === "blocked") {
    return {
      ok: false as const,
      error: makeError(403, `Blocked operation: ${operation_id}`, policy.reason),
    };
  }

  if (policy.mode === "advanced" && scope_mode !== "all") {
    return {
      ok: false as const,
      error: makeError(
        403,
        `Operation ${operation_id} requires scope_mode="all"`,
        policy.advancedWarning ?? policy.reason,
      ),
    };
  }

  const normalizedPathParams = normalizePathParams(project, path_params);
  const path = interpolatePath(catalogEntry.pathTemplate, normalizedPathParams);
  const validatedQuery = validateQueryParams(catalogEntry.queryParamNames, query);
  const finalQuery = {
    ...(validatedQuery ?? {}),
    ...(catalogEntry.queryParamNames.includes("page[size]") ? { "page[size]": page_size } : {}),
    ...(catalogEntry.queryParamNames.includes("page[number]")
      ? { "page[number]": page_number }
      : {}),
  };

  return {
    ok: true as const,
    catalogEntry,
    policy,
    url: `${baseUrl}${path}${toQueryString(finalQuery)}`,
  };
}

export function registerGenericReadTool(server: McpServer) {
  server.registerTool(
    "polarion_api_read",
    {
      title: "Polarion API Read",
      description:
        "Read a validated allowlisted Polarion GET operation by operation_id. Prefer curated tools when available.",
      inputSchema: {
        operation_id: z.string().describe("Allowlisted Polarion GET operationId"),
        project: z
          .string()
          .optional()
          .describe("Project ID convenience field for project-scoped operations"),
        path_params: z
          .record(z.string(), z.string())
          .optional()
          .describe("Additional path parameters for the selected operation"),
        query: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Validated query parameters for the selected operation"),
        scope_mode: z.enum(["project", "all"]).optional().default("project"),
        page_size: z.number().min(1).max(MAX_PAGE_SIZE).optional().default(DEFAULT_PAGE_SIZE),
        page_number: z.number().min(1).optional().default(1),
      },
    },
    withToolLogging(
      "polarion_api_read",
      async ({
        operation_id,
        project,
        path_params,
        query,
        scope_mode,
        page_size,
        page_number,
      }, extra) => {
        try {
          const built = buildReadUrl(
            readBaseUrl(),
            operation_id,
            project,
            path_params,
            query,
            scope_mode,
            page_size,
            page_number,
          );
          if (!built.ok) return errorResult(built.error);

          const { catalogEntry, policy, url } = built;
          const response = await fetch(url, {
            method: "GET",
            headers: {
              Accept: "application/json",
              ...authHeaders(extra),
            },
          });

          if (!response.ok) {
            return errorResult(
              makeError(
                response.status,
                `HTTP ${response.status}`,
                await response.text(),
              ),
            );
          }

          const rawData = await response.json();
          const truncated = truncateResponse(rawData, {
            maxItems: page_size,
            maxChars: MAX_RESPONSE_CHARS,
          });

          return ok({
            operation_id,
            path: catalogEntry.pathTemplate,
            policy_mode: policy.mode,
            preferred_tool: policy.preferredTool,
            data: truncated.data,
            truncation: truncated.truncation,
          });
        } catch (error) {
          return errorResult(networkError(error));
        }
      },
      ({
        operation_id,
        scope_mode,
        page_size,
        page_number,
      }, result) => {
        const content = Array.isArray((result as { content?: unknown[] } | undefined)?.content)
          ? (result as { content: { type: string; text?: string }[] }).content[0]
          : undefined;
        let parsed: Record<string, unknown> | undefined;
        if (content?.type === "text" && content.text) {
          try {
            parsed = JSON.parse(content.text);
          } catch {
            parsed = undefined;
          }
        }

        return {
          operation_id,
          scope_mode,
          page_size,
          page_number,
          policy_mode: typeof parsed?.["policy_mode"] === "string"
            ? parsed["policy_mode"]
            : undefined,
          truncated: !!parsed &&
            typeof parsed["truncation"] === "object" &&
            parsed["truncation"] !== null,
        };
      },
    ),
  );
}
