import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { client } from "../../client.ts";
import { httpError, networkError } from "../../errors.ts";
import { authHeaders, errorResult, fieldsParam, ok, pagination } from "../../helpers.ts";
import { withToolLogging } from "../../logging.ts";

export function registerDocumentTools(server: McpServer) {
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
        page_size: z.number().min(1).max(50).optional().default(20).describe("Items per page"),
        page_number: z
          .number()
          .min(1)
          .optional()
          .default(1)
          .describe("1-indexed page number"),
      },
    },
    withToolLogging(
      "list_documents",
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
      ({ page_size, page_number }) => ({ page_size, page_number }),
    ),
  );

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
    withToolLogging(
      "get_document",
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
    ),
  );
}
