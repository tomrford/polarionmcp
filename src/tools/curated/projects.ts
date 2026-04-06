import { z } from "zod/v4";
import { client } from "../../client.ts";
import { httpError, networkError } from "../../errors.ts";
import { authHeaders, errorResult, fieldsParam, ok, pagination } from "../../helpers.ts";
import { withToolLogging } from "../../logging.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

export function registerProjectsTools(server: McpServer) {
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
      "list_projects",
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
      ({ page_size, page_number }) => ({ page_size, page_number }),
    ),
  );
}
