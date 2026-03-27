import { z } from "zod/v4";
import { client } from "../client.ts";
import { httpError, networkError } from "../errors.ts";
import { authHeaders, errorResult, ok } from "../helpers.ts";
import { withToolLogging } from "../logging.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerCommentTools(server: McpServer) {
  server.registerTool(
    "add_work_item_comment",
    {
      title: "Add Work Item Comment",
      description: "Add one explicit comment to a work item.",
      inputSchema: {
        project: z.string().describe("Project ID"),
        work_item_id: z.string().describe("Work item ID"),
        text: z.string().min(1).describe("Comment text"),
        text_type: z
          .enum(["text/plain", "text/html"])
          .optional()
          .default("text/plain")
          .describe("Comment text MIME type"),
      },
    },
    withToolLogging(
      "add_work_item_comment",
      async ({ project, work_item_id, text, text_type }, extra) => {
        try {
          const { data, error, response } = await client.POST(
            "/projects/{projectId}/workitems/{workItemId}/comments",
            {
              headers: authHeaders(extra),
              params: {
                path: { projectId: project, workItemId: work_item_id },
              },
              body: {
                data: [
                  {
                    type: "workitem_comments",
                    attributes: {
                      text: {
                        type: text_type,
                        value: text,
                      },
                    },
                  },
                ],
              },
            },
          );

          if (error || !response.ok) {
            return errorResult(httpError(response.status, error));
          }

          return ok({
            created: true,
            comment_id: data?.data?.[0]?.id,
            work_item: `${project}/${work_item_id}`,
          });
        } catch (error) {
          return errorResult(networkError(error));
        }
      },
      ({ project, work_item_id }) => ({
        target_id: `${project}/${work_item_id}`,
      }),
    ),
  );
}
