import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { searchCatalog } from "../catalog";
import { getPolarionAccessToken } from "../request-context";

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function registerSearchTool(server: McpServer) {
  server.registerTool(
    "search",
    {
      title: "Polarion operation search",
      description:
        "Fuzzy-search the Polarion code tool catalog by function name, partial name, route intent, or parameter name. Use this before code when you are unsure what to call.",
      inputSchema: z.object({
        query: z
          .string()
          .describe("Partial tool name, route intent, or parameter keyword to search for"),
        limit: z
          .number()
          .min(1)
          .max(20)
          .optional()
          .default(8)
          .describe("Maximum matches to return"),
      }),
      annotations: {
        title: "Polarion operation search",
        readOnlyHint: true,
      },
    },
    ({ query, limit }) => {
      try {
        if (!getPolarionAccessToken()) {
          throw new Error("No Polarion access token available");
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(searchCatalog(query, limit)),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${formatError(error)}` }],
          isError: true,
        };
      }
    },
  );
}
