import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod/v4";
import { client } from "./client.ts";
import { httpError, networkError } from "./errors.ts";
import { pagination, errorResult, ok, fieldsParam } from "./helpers.ts";

/** Extract a Bearer token from the MCP request context, falling back to env var for stdio mode. */
function authHeaders(extra: { authInfo?: { token: string }; requestInfo?: { headers: Record<string, string | string[] | undefined> } }): { Authorization: string } {
  const rawHeader = extra.requestInfo?.headers?.["authorization"];
  const headerToken = typeof rawHeader === "string" ? rawHeader.replace(/^Bearer\s+/i, "") : undefined;
  const token = extra.authInfo?.token ?? headerToken ?? process.env["POLARION_ACCESS_TOKEN"];
  if (!token) throw new Error("No Polarion access token available");
  return { Authorization: `Bearer ${token}` };
}

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
  async ({ query, fields, page_size, page_number }, extra) => {
    try {
      const { data, error, response } = await client.GET("/projects", {
        headers: authHeaders(extra),
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
  async ({ project, query, fields, page_size, page_number }, extra) => {
    try {
      const { data, error, response } = await client.GET(
        "/projects/{projectId}/documents",
        {
          headers: authHeaders(extra),
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
  async ({ project, space, document, revision, fields }, extra) => {
    try {
      const { data, error, response } = await client.GET(
        "/projects/{projectId}/spaces/{spaceId}/documents/{documentName}",
        {
          headers: authHeaders(extra),
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
);

// ---------- start ----------

const isStdio = process.argv.includes("--stdio");
const defaultHttpPort = 8080;

function httpPort(): number {
  const rawPort = process.env["PORT"];
  if (!rawPort) return defaultHttpPort;

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT value: ${rawPort}`);
  }
  return port;
}

if (isStdio) {
  // Local dev/test mode: token comes from POLARION_ACCESS_TOKEN env var
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Polarion MCP running in stdio mode");
} else {
  // Production HTTP mode: token comes from each client's Authorization header
  type Transport = InstanceType<typeof WebStandardStreamableHTTPServerTransport>;
  const sessions = new Map<string, Transport>();

  const port = httpPort();

  Bun.serve({
    port,
    routes: {
      "/mcp": {
        POST: async (req) => {
          // Check for existing session
          const sessionId = req.headers.get("mcp-session-id");
          let transport: Transport;

          if (sessionId && sessions.has(sessionId)) {
            transport = sessions.get(sessionId)!;
          } else if (!sessionId) {
            // New session — create transport
            transport = new WebStandardStreamableHTTPServerTransport({
              sessionIdGenerator: () => crypto.randomUUID(),
              onsessioninitialized: (id) => {
                sessions.set(id, transport);
              },
              onsessionclosed: (id) => {
                sessions.delete(id);
              },
            });
            transport.onclose = () => {
              if (transport.sessionId) sessions.delete(transport.sessionId);
            };
            await server.connect(transport);
          } else {
            return new Response("Session not found", { status: 404 });
          }

          // Extract bearer token and pass as authInfo
          const authHeader = req.headers.get("authorization");
          const token = authHeader?.replace(/^Bearer\s+/i, "");

          return transport.handleRequest(req, {
            authInfo: token ? { token, clientId: "polarion-mcp-client", scopes: [] } : undefined,
          });
        },
        GET: async (req) => {
          const sessionId = req.headers.get("mcp-session-id");
          const transport = sessionId ? sessions.get(sessionId) : undefined;
          if (!transport) {
            return new Response("Session not found", { status: 404 });
          }
          return transport.handleRequest(req);
        },
        DELETE: async (req) => {
          const sessionId = req.headers.get("mcp-session-id");
          const transport = sessionId ? sessions.get(sessionId) : undefined;
          if (!transport) {
            return new Response("Session not found", { status: 404 });
          }
          return transport.handleRequest(req);
        },
      },
    },
  });

  console.log(
    `Polarion MCP running on http://localhost:${port}/mcp (TLS should terminate at the proxy/load balancer)`
  );
}
