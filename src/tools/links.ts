import { z } from "zod/v4";
import { client } from "../client.ts";
import { httpError, networkError } from "../errors.ts";
import { authHeaders, errorResult, ok } from "../helpers.ts";
import { withToolLogging } from "../logging.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerLinkTools(server: McpServer) {
  server.registerTool(
    "add_work_item_link",
    {
      title: "Add Work Item Link",
      description: "Create one explicit link from a work item to another known work item.",
      inputSchema: {
        project: z.string().describe("Source project ID"),
        work_item_id: z.string().describe("Source work item ID"),
        target_project: z.string().describe("Target project ID"),
        target_work_item_id: z.string().describe("Target work item ID"),
        role: z.string().describe("Link role ID"),
        suspect: z.boolean().optional().default(false).describe(
          "Whether the link should be marked suspect",
        ),
      },
    },
    withToolLogging(
      "add_work_item_link",
      async ({
        project,
        work_item_id,
        target_project,
        target_work_item_id,
        role,
        suspect,
      }, extra) => {
        try {
          const { data, error, response } = await client.POST(
            "/projects/{projectId}/workitems/{workItemId}/linkedworkitems",
            {
              headers: authHeaders(extra),
              params: {
                path: { projectId: project, workItemId: work_item_id },
              },
              body: {
                data: [
                  {
                    type: "linkedworkitems",
                    attributes: { role, suspect },
                    relationships: {
                      workItem: {
                        data: {
                          type: "workitems",
                          id: `${target_project}/${target_work_item_id}`,
                        },
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
            link_id: data?.data?.[0]?.id,
          });
        } catch (err) {
          return errorResult(networkError(err));
        }
      },
      ({ project, work_item_id, target_project, target_work_item_id, role }) => ({
        target_id: `${project}/${work_item_id}:${role}:${target_project}/${target_work_item_id}`,
      }),
    ),
  );

  server.registerTool(
    "update_work_item_link",
    {
      title: "Update Work Item Link",
      description: "Update one explicit work item link, currently for suspect flag changes.",
      inputSchema: {
        project: z.string().describe("Source project ID"),
        work_item_id: z.string().describe("Source work item ID"),
        target_project: z.string().describe("Target project ID"),
        target_work_item_id: z.string().describe("Target work item ID"),
        role: z.string().describe("Link role ID"),
        suspect: z.boolean().describe("Updated suspect flag"),
      },
    },
    withToolLogging(
      "update_work_item_link",
      async ({
        project,
        work_item_id,
        target_project,
        target_work_item_id,
        role,
        suspect,
      }, extra) => {
        try {
          const { error, response } = await client.PATCH(
            "/projects/{projectId}/workitems/{workItemId}/linkedworkitems/{roleId}/{targetProjectId}/{linkedWorkItemId}",
            {
              headers: authHeaders(extra),
              params: {
                path: {
                  projectId: project,
                  workItemId: work_item_id,
                  roleId: role,
                  targetProjectId: target_project,
                  linkedWorkItemId: target_work_item_id,
                },
              },
              body: {
                data: {
                  type: "linkedworkitems",
                  id: `${project}/${work_item_id}/${role}/${target_project}/${target_work_item_id}`,
                  attributes: { suspect },
                },
              },
            },
          );

          if (error || !response.ok) {
            return errorResult(httpError(response.status, error));
          }

          return ok({
            updated: true,
            suspect,
          });
        } catch (err) {
          return errorResult(networkError(err));
        }
      },
      ({ project, work_item_id, target_project, target_work_item_id, role }) => ({
        target_id: `${project}/${work_item_id}:${role}:${target_project}/${target_work_item_id}`,
      }),
    ),
  );

  server.registerTool(
    "remove_work_item_link",
    {
      title: "Remove Work Item Link",
      description: "Remove one explicit link between two known work items.",
      inputSchema: {
        project: z.string().describe("Source project ID"),
        work_item_id: z.string().describe("Source work item ID"),
        target_project: z.string().describe("Target project ID"),
        target_work_item_id: z.string().describe("Target work item ID"),
        role: z.string().describe("Link role ID"),
      },
    },
    withToolLogging(
      "remove_work_item_link",
      async ({
        project,
        work_item_id,
        target_project,
        target_work_item_id,
        role,
      }, extra) => {
        try {
          const { error, response } = await client.DELETE(
            "/projects/{projectId}/workitems/{workItemId}/linkedworkitems/{roleId}/{targetProjectId}/{linkedWorkItemId}",
            {
              headers: authHeaders(extra),
              params: {
                path: {
                  projectId: project,
                  workItemId: work_item_id,
                  roleId: role,
                  targetProjectId: target_project,
                  linkedWorkItemId: target_work_item_id,
                },
              },
            },
          );

          if (error || !response.ok) {
            return errorResult(httpError(response.status, error));
          }

          return ok({
            removed: true,
          });
        } catch (err) {
          return errorResult(networkError(err));
        }
      },
      ({ project, work_item_id, target_project, target_work_item_id, role }) => ({
        target_id: `${project}/${work_item_id}:${role}:${target_project}/${target_work_item_id}`,
      }),
    ),
  );
}
