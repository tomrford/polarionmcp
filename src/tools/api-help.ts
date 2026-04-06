import { z } from "zod/v4";
import { ok } from "../helpers.ts";
import { withToolLogging } from "../logging.ts";
import { getResolvedReadOperations } from "../openapi/read-policy.ts";
import type { ResolvedReadOperation } from "../openapi/read-types.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const MAX_MATCHES_PER_BUCKET = 8;

function matchesKeyword(entry: ResolvedReadOperation, keyword: string) {
  const haystacks = [
    entry.catalogEntry.operationId,
    entry.catalogEntry.pathTemplate,
    entry.catalogEntry.description,
    entry.catalogEntry.resourceGroup,
    entry.policy.preferredTool,
  ]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());

  const needle = keyword.toLowerCase();
  return haystacks.some((value) => value.includes(needle));
}

function summarizeOperation(entry: ResolvedReadOperation) {
  return {
    operation_id: entry.catalogEntry.operationId,
    path: entry.catalogEntry.pathTemplate,
    resource_type: entry.catalogEntry.resourceGroup,
    required_path_params: entry.catalogEntry.pathParamNames,
    key_query_params: entry.catalogEntry.queryParamNames,
    policy_mode: entry.policy.mode,
    preferred_tool: entry.policy.preferredTool,
    description: entry.catalogEntry.description,
    warning: entry.policy.advancedWarning,
  };
}

export function helpSearch(
  keyword: string | undefined,
  resource_type: string | undefined,
  include_blocked: boolean,
) {
  const all = getResolvedReadOperations();
  const filtered = all.filter((entry) => {
    if (!include_blocked && entry.policy.mode === "blocked") return false;
    if (resource_type && entry.catalogEntry.resourceGroup !== resource_type) return false;
    if (keyword && !matchesKeyword(entry, keyword)) return false;
    return true;
  });

  const curated = filtered
    .filter((entry) => entry.policy.mode === "curated")
    .map(summarizeOperation);
  const generic_read = filtered
    .filter((entry) => entry.policy.mode === "allowed")
    .map(summarizeOperation);
  const advanced = filtered
    .filter((entry) => entry.policy.mode === "advanced")
    .map(summarizeOperation);
  const blocked = filtered
    .filter((entry) => entry.policy.mode === "blocked")
    .map(summarizeOperation);

  if (!keyword && !resource_type) {
    const byResource = Object.entries(
      all
        .filter((entry) => include_blocked || entry.policy.mode !== "blocked")
        .reduce<Record<string, number>>((acc, entry) => {
          acc[entry.catalogEntry.resourceGroup] = (acc[entry.catalogEntry.resourceGroup] ?? 0) + 1;
          return acc;
        }, {}),
    )
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([resource, count]) => ({ resource, count }));

    return {
      summary: {
        total_operations: byResource.reduce((sum, entry) => sum + entry.count, 0),
        by_resource: byResource,
      },
      curated_recommendations: curated.slice(0, MAX_MATCHES_PER_BUCKET),
      next_step:
        "Use polarion_api_help with keyword or resource_type to narrow results. Prefer curated tools when available.",
    };
  }

  return {
    summary: {
      total_matches: curated.length + generic_read.length + advanced.length + blocked.length,
      filters: {
        keyword,
        resource_type,
        include_blocked,
      },
    },
    curated_recommendations: curated.slice(0, 12),
    generic_read_options: generic_read.slice(0, 20),
    advanced_options: advanced.slice(0, 12),
    blocked_matches: include_blocked ? blocked.slice(0, 12) : undefined,
    next_step:
      "Prefer a curated tool when listed. Otherwise call polarion_api_read with the chosen operation_id.",
  };
}

export function registerApiHelpTool(server: McpServer) {
  server.registerTool(
    "polarion_api_help",
    {
      title: "Polarion API Help",
      description: "Discover curated and generic read operations by keyword or resource type.",
      inputSchema: {
        keyword: z
          .string()
          .optional()
          .describe("Keyword or intent, e.g. comments, approvals, test runs"),
        resource_type: z
          .string()
          .optional()
          .describe("Resource type, e.g. workitems, documents, testruns"),
        include_blocked: z
          .boolean()
          .optional()
          .default(false)
          .describe("Include blocked operations in help output"),
      },
    },
    withToolLogging(
      "polarion_api_help",
      async ({ keyword, resource_type, include_blocked }) =>
        ok(helpSearch(keyword, resource_type, include_blocked)),
      ({ keyword, resource_type }) => ({
        operation_id: keyword,
        target_id: resource_type,
      }),
    ),
  );
}
