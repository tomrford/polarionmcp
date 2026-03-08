import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";
import { client } from "./client.ts";
import { httpError, networkError } from "./errors.ts";
import { pagination, errorResult, ok, fieldsParam } from "./helpers.ts";

const server = new McpServer(
  {
    name: "polarion-mcp",
    version: "0.1.0",
  },
  {
    instructions: `Polarion query syntax reference:
- Lucene-style field queries: field:value, field:val* (wildcard)
- Boolean operators: AND, OR, NOT, parentheses for grouping
- Common fields: type, status, id, title, priority, severity, created, updated
- Examples: type:requirement AND status:open, id:PRJ*, severity:must_have
- Bare text matches exact ID

Custom fields:
- Custom fields are type-specific. Use get_fields_metadata with target_type to discover them.
- Example: type "sysparameter" has custom fields: parval, parmin, parmax, parunit, swname
- Request custom fields via the fields param: fields="title,parval,parunit"
- Query sysparameters: query="type:sysparameter"`,
  },
);

// ---------- list_projects ----------

server.registerTool(
  "list_projects",
  {
    title: "List Projects",
    description: "List available Polarion projects (paginated).",
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe("Polarion query syntax (see server instructions)"),
      fields: z
        .string()
        .optional()
        .describe("Comma-separated attribute fields to return"),
      page_size: z.number().min(1).optional().default(50).describe("Items per page"),
      page_number: z
        .number()
        .min(1)
        .optional()
        .default(1)
        .describe("1-indexed page number"),
    },
  },
  async ({ query, fields, page_size, page_number }) => {
    try {
      const { data, error, response } = await client.GET("/projects", {
        params: {
          query: {
            "page[size]": page_size,
            "page[number]": page_number,
            query,
            fields: fieldsParam("projects", fields),
          },
        },
      });
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
);

// ---------- list_work_items ----------

server.registerTool(
  "list_work_items",
  {
    title: "List Work Items",
    description:
      "List work items in a Polarion project (paginated, filterable).",
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
      page_size: z.number().min(1).optional().default(50).describe("Items per page"),
      page_number: z
        .number()
        .min(1)
        .optional()
        .default(1)
        .describe("1-indexed page number"),
    },
  },
  async ({ project, query, fields, revision, page_size, page_number }) => {
    try {
      const { data, error, response } = await client.GET(
        "/projects/{projectId}/workitems",
        {
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
);

// ---------- get_work_item ----------

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
  async ({ project, work_item_id, revision, fields }) => {
    try {
      const { data, error, response } = await client.GET(
        "/projects/{projectId}/workitems/{workItemId}",
        {
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
);

// ---------- get_fields_metadata ----------

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
  async ({ project, resource_type, target_type }) => {
    try {
      const { data, error, response } = await client.GET(
        "/projects/{projectId}/actions/getFieldsMetadata",
        {
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
);

// ---------- update_work_item ----------

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
  async ({
    project,
    work_item_id,
    attributes,
    workflow_action,
    change_type_to,
  }) => {
    try {
      const { error, response } = await client.PATCH(
        "/projects/{projectId}/workitems/{workItemId}",
        {
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
);

// ---------- list_documents ----------

server.registerTool(
  "list_documents",
  {
    title: "List Documents",
    description: "List documents in a Polarion project (paginated, filterable).",
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
      page_size: z.number().min(1).optional().default(50).describe("Items per page"),
      page_number: z
        .number()
        .min(1)
        .optional()
        .default(1)
        .describe("1-indexed page number"),
    },
  },
  async ({ project, query, fields, page_size, page_number }) => {
    try {
      const { data, error, response } = await client.GET(
        "/projects/{projectId}/documents",
        {
          params: {
            path: { projectId: project },
            query: {
              "page[size]": page_size,
              "page[number]": page_number,
              query,
              fields: fieldsParam("documents", fields),
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
);

// ---------- get_document ----------

server.registerTool(
  "get_document",
  {
    title: "Get Document",
    description: "Get a single Polarion document by space and name.",
    inputSchema: {
      project: z.string().describe("Project ID"),
      space: z
        .string()
        .describe("Space ID (use '_default' for the default space)"),
      document: z.string().describe("Document name"),
      revision: z.string().optional().describe("Revision ID"),
      fields: z
        .string()
        .optional()
        .describe("Comma-separated attribute fields (omit for all)"),
    },
  },
  async ({ project, space, document, revision, fields }) => {
    try {
      const { data, error, response } = await client.GET(
        "/projects/{projectId}/spaces/{spaceId}/documents/{documentName}",
        {
          params: {
            path: {
              projectId: project,
              spaceId: space,
              documentName: document,
            },
            query: {
              revision,
              fields: fieldsParam("documents", fields),
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
);

// ---------- list_linked_work_items ----------

server.registerTool(
  "list_linked_work_items",
  {
    title: "List Linked Work Items",
    description:
      "List direct outgoing links from a work item to other work items.",
    inputSchema: {
      project: z.string().describe("Project ID"),
      work_item_id: z.string().describe("Work Item ID"),
      fields: z
        .string()
        .optional()
        .describe("Comma-separated attribute fields to return"),
      page_size: z.number().min(1).optional().default(50).describe("Items per page"),
      page_number: z
        .number()
        .min(1)
        .optional()
        .default(1)
        .describe("1-indexed page number"),
    },
  },
  async ({ project, work_item_id, fields, page_size, page_number }) => {
    try {
      const { data, error, response } = await client.GET(
        "/projects/{projectId}/workitems/{workItemId}/linkedworkitems",
        {
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
);

// ---------- get_enum_options ----------

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
  async ({ project, field_id }) => {
    try {
      const { data, error, response } = await client.GET(
        "/projects/{projectId}/workitems/fields/{fieldId}/actions/getAvailableOptions",
        {
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
);

// ---------- get_workflow_actions ----------

server.registerTool(
  "get_workflow_actions",
  {
    title: "Get Workflow Actions",
    description:
      "Returns available workflow actions for a work item.",
    inputSchema: {
      project: z.string().describe("Project ID"),
      work_item_id: z.string().describe("Work Item ID"),
    },
  },
  async ({ project, work_item_id }) => {
    try {
      const { data, error, response } = await client.GET(
        "/projects/{projectId}/workitems/{workItemId}/actions/getWorkflowActions",
        {
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
);

// ---------- start ----------

const transport = new StdioServerTransport();
await server.connect(transport);
