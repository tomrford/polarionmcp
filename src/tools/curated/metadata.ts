import { z } from "zod/v4";
import { client } from "../../client.ts";
import { httpError, networkError } from "../../errors.ts";
import { authHeaders, errorResult, ok } from "../../helpers.ts";
import { withToolLogging } from "../../logging.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerMetadataTools(server: McpServer) {
  server.registerTool(
    "get_fields_metadata",
    {
      title: "Get Fields Metadata",
      description:
        "Returns field definitions for a resource type in a project. Supports: workitems, documents, testruns, plans.",
      inputSchema: {
        project: z.string().describe("Project ID"),
        resource_type: z
          .string()
          .describe("Resource type: workitems | documents | testruns | plans"),
        target_type: z
          .string()
          .optional()
          .describe(
            "Work item type (e.g. requirement). Use '~' for no target type.",
          ),
      },
    },
    withToolLogging(
      "get_fields_metadata",
      async ({ project, resource_type, target_type }, extra) => {
        try {
          const { data, error, response } = await client.GET(
            "/projects/{projectId}/actions/getFieldsMetadata",
            {
              headers: authHeaders(extra),
              params: {
                path: { projectId: project },
                query: { resourceType: resource_type, targetType: target_type },
              },
            },
          );
          if (error || !response.ok) {
            return errorResult(httpError(response.status, error));
          }
          return ok(data?.data?.attributes ?? {});
        } catch (err) {
          return errorResult(networkError(err));
        }
      },
    ),
  );
}
