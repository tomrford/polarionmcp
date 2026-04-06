import { z } from "zod/v4";
import { client } from "../../client.ts";
import { httpError, networkError } from "../../errors.ts";
import { authHeaders, errorResult, fieldsParam, ok, pagination } from "../../helpers.ts";
import { withToolLogging } from "../../logging.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

export function registerWorkItemTools(server: McpServer) {
  server.registerTool(
    "list_work_items",
    {
      title: "List Work Items",
      description: "List work items in a Polarion project (paginated, filterable).",
      inputSchema: {
        project: z.string().describe("Project ID"),
        query: z
          .string()
          .optional()
          .describe("Polarion query syntax (see server instructions)"),
        fields: z
          .string()
          .optional()
          .describe("Comma-separated attribute fields to return"),
        revision: z.string().optional().describe("Revision ID"),
        page_size: z
          .number()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .optional()
          .default(DEFAULT_PAGE_SIZE)
          .describe("Items per page"),
        page_number: z
          .number()
          .min(1)
          .optional()
          .default(1)
          .describe("1-indexed page number"),
      },
    },
    withToolLogging(
      "list_work_items",
      async ({ project, query, fields, revision, page_size, page_number }, extra) => {
        try {
          const { data, error, response } = await client.GET(
            "/projects/{projectId}/workitems",
            {
              headers: authHeaders(extra),
              params: {
                path: { projectId: project },
                query: {
                  "page[size]": page_size,
                  "page[number]": page_number,
                  query,
                  revision,
                  fields: fieldsParam("workitems", fields),
                },
              },
            },
          );
          if (error || !response.ok) {
            return errorResult(httpError(response.status, error));
          }
          const items = (data?.data ?? []).map((d) => ({
            id: d.id,
            type: d.type,
            attributes: d.attributes,
          }));
          return ok({
            items,
            pagination: pagination(
              data?.meta?.totalCount,
              page_size,
              page_number,
              data?.links?.next,
            ),
          });
        } catch (err) {
          return errorResult(networkError(err));
        }
      },
      ({ page_size, page_number }) => ({
        page_size,
        page_number,
      }),
    ),
  );

  server.registerTool(
    "get_work_item",
    {
      title: "Get Work Item",
      description: "Get a single Polarion work item by ID with full detail.",
      inputSchema: {
        project: z.string().describe("Project ID"),
        work_item_id: z.string().describe("Work item ID"),
        revision: z.string().optional().describe("Revision ID"),
        fields: z
          .string()
          .optional()
          .describe("Comma-separated attribute fields (omit for all)"),
      },
    },
    withToolLogging(
      "get_work_item",
      async ({ project, work_item_id, revision, fields }, extra) => {
        try {
          const { data, error, response } = await client.GET(
            "/projects/{projectId}/workitems/{workItemId}",
            {
              headers: authHeaders(extra),
              params: {
                path: { projectId: project, workItemId: work_item_id },
                query: {
                  revision,
                  fields: fieldsParam("workitems", fields),
                },
              },
            },
          );
          if (error || !response.ok) {
            return errorResult(httpError(response.status, error));
          }
          return ok({
            id: data?.data?.id,
            type: data?.data?.type,
            attributes: data?.data?.attributes,
          });
        } catch (err) {
          return errorResult(networkError(err));
        }
      },
    ),
  );

  server.registerTool(
    "update_work_item",
    {
      title: "Update Work Item",
      description:
        "Sparse PATCH of a work item. Only provided attributes are changed. Use get_fields_metadata to discover available fields.",
      inputSchema: {
        project: z.string().describe("Project ID"),
        work_item_id: z.string().describe("Work Item ID"),
        attributes: z
          .record(z.string(), z.unknown())
          .describe("Key/value pairs of fields to update"),
        workflow_action: z
          .string()
          .optional()
          .describe("Workflow action to execute"),
        change_type_to: z
          .string()
          .optional()
          .describe("Change work item to this type"),
      },
    },
    withToolLogging(
      "update_work_item",
      async ({
        project,
        work_item_id,
        attributes,
        workflow_action,
        change_type_to,
      }, extra) => {
        try {
          const { error, response } = await client.PATCH(
            "/projects/{projectId}/workitems/{workItemId}",
            {
              headers: authHeaders(extra),
              params: {
                path: { projectId: project, workItemId: work_item_id },
                query: {
                  workflowAction: workflow_action,
                  changeTypeTo: change_type_to,
                },
              },
              body: {
                data: {
                  type: "workitems" as const,
                  id: `${project}/${work_item_id}`,
                  attributes,
                },
              },
            },
          );
          if (error || !response.ok) {
            return errorResult(httpError(response.status, error));
          }
          return ok({ updated: `${project}/${work_item_id}` });
        } catch (err) {
          return errorResult(networkError(err));
        }
      },
      ({
        workflow_action,
        change_type_to,
        attributes,
      }) => ({
        workflow_action,
        change_type_to,
        attribute_count: Object.keys(attributes).length,
      }),
    ),
  );

  server.registerTool(
    "list_linked_work_items",
    {
      title: "List Linked Work Items",
      description: "List direct outgoing links from a work item to other work items.",
      inputSchema: {
        project: z.string().describe("Project ID"),
        work_item_id: z.string().describe("Work Item ID"),
        fields: z
          .string()
          .optional()
          .describe("Comma-separated attribute fields to return"),
        page_size: z
          .number()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .optional()
          .default(DEFAULT_PAGE_SIZE)
          .describe("Items per page"),
        page_number: z
          .number()
          .min(1)
          .optional()
          .default(1)
          .describe("1-indexed page number"),
      },
    },
    withToolLogging(
      "list_linked_work_items",
      async ({ project, work_item_id, fields, page_size, page_number }, extra) => {
        try {
          const { data, error, response } = await client.GET(
            "/projects/{projectId}/workitems/{workItemId}/linkedworkitems",
            {
              headers: authHeaders(extra),
              params: {
                path: { projectId: project, workItemId: work_item_id },
                query: {
                  "page[size]": page_size,
                  "page[number]": page_number,
                  fields: fieldsParam("linkedworkitems", fields),
                },
              },
            },
          );
          if (error || !response.ok) {
            return errorResult(httpError(response.status, error));
          }
          const items = (data?.data ?? []).map((d) => ({
            id: d.id,
            type: d.type,
            attributes: d.attributes,
          }));
          return ok({
            items,
            pagination: pagination(
              data?.meta?.totalCount,
              page_size,
              page_number,
              data?.links?.next,
            ),
          });
        } catch (err) {
          return errorResult(networkError(err));
        }
      },
      ({ page_size, page_number }) => ({
        page_size,
        page_number,
      }),
    ),
  );

  server.registerTool(
    "get_enum_options",
    {
      title: "Get Enum Options",
      description:
        "Returns available enum options for a work item field (e.g. severity, priority).",
      inputSchema: {
        project: z.string().describe("Project ID"),
        field_id: z.string().describe("Field ID (e.g. severity, priority)"),
      },
    },
    withToolLogging(
      "get_enum_options",
      async ({ project, field_id }, extra) => {
        try {
          const { data, error, response } = await client.GET(
            "/projects/{projectId}/workitems/fields/{fieldId}/actions/getAvailableOptions",
            {
              headers: authHeaders(extra),
              params: {
                path: { projectId: project, fieldId: field_id },
              },
            },
          );
          if (error || !response.ok) {
            return errorResult(httpError(response.status, error));
          }
          return ok(data?.data ?? []);
        } catch (err) {
          return errorResult(networkError(err));
        }
      },
    ),
  );

  server.registerTool(
    "get_workflow_actions",
    {
      title: "Get Workflow Actions",
      description: "Returns available workflow actions for a work item.",
      inputSchema: {
        project: z.string().describe("Project ID"),
        work_item_id: z.string().describe("Work Item ID"),
      },
    },
    withToolLogging(
      "get_workflow_actions",
      async ({ project, work_item_id }, extra) => {
        try {
          const { data, error, response } = await client.GET(
            "/projects/{projectId}/workitems/{workItemId}/actions/getWorkflowActions",
            {
              headers: authHeaders(extra),
              params: {
                path: { projectId: project, workItemId: work_item_id },
              },
            },
          );
          if (error || !response.ok) {
            return errorResult(httpError(response.status, error));
          }
          return ok(data?.data ?? []);
        } catch (err) {
          return errorResult(networkError(err));
        }
      },
    ),
  );
}
