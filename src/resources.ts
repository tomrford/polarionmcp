import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const QUERY_SYNTAX_URI = "polarion://guides/query-syntax";
const MCP_USAGE_URI = "polarion://guides/mcp-usage";

const QUERY_SYNTAX_GUIDE = `Polarion query syntax quick guide

- Use Lucene-style field queries: field:value
- Wildcards are supported: id:REQ* or title:spec*
- Combine clauses with AND, OR, NOT
- Use parentheses for grouping: (type:requirement OR type:defect) AND status:open
- Bare text usually matches exact IDs best

Common work item fields:
- id
- title
- type
- status
- priority
- severity
- created
- updated

Common examples:
- type:requirement AND status:open
- type:defect AND severity:critical
- id:REQ*
- title:authentication

Custom fields:
- Custom fields are type-specific
- Use get_fields_metadata before querying or updating unfamiliar custom fields
- Request custom fields explicitly with sparse fields, for example fields="title,parval,parunit"

Pagination and response discipline:
- Prefer small pages
- Use fields to reduce payload size
- Use narrower filters instead of broad fetches when possible`;

const MCP_USAGE_GUIDE = `Polarion MCP usage guide

Preferred workflow:
1. Use a curated tool when one exists
2. If unsure which operation fits, call polarion_api_help
3. Use polarion_api_read only when no curated tool fits
4. Fetch incrementally with pagination and sparse fields

Curated tools are best for:
- listing projects
- listing work items
- getting one work item
- listing documents
- getting one document
- discovering fields, enums, and workflow actions
- updating one work item explicitly

Generic read is best for:
- uncommon read-only operations
- drilling into a known operationId with validated path/query params

Safety guidance:
- Prefer project-scoped reads
- Use scope_mode="all" only for intentional cross-project reads
- Expect large results to be truncated
- If a response is truncated, narrow fields, filters, or page size and fetch the next slice

Mutation guidance:
- Use get_fields_metadata before unfamiliar updates
- Use get_workflow_actions before status-like changes
- Check existing links before adding or updating a work item link
- Keep mutations narrow and explicit`;

export function registerResources(server: McpServer) {
  server.registerResource(
    "query-syntax-guide",
    QUERY_SYNTAX_URI,
    {
      title: "Polarion Query Syntax Guide",
      description: "Reference for Polarion query syntax and filtering patterns",
      mimeType: "text/plain",
    },
    async () => ({
      contents: [
        {
          uri: QUERY_SYNTAX_URI,
          text: QUERY_SYNTAX_GUIDE,
        },
      ],
    }),
  );

  server.registerResource(
    "mcp-usage-guide",
    MCP_USAGE_URI,
    {
      title: "Polarion MCP Usage Guide",
      description: "Guidance on choosing curated tools, help, and generic reads",
      mimeType: "text/plain",
    },
    async () => ({
      contents: [
        {
          uri: MCP_USAGE_URI,
          text: MCP_USAGE_GUIDE,
        },
      ],
    }),
  );
}
