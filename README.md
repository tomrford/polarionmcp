# polarion-mcp

MCP server that exposes Polarion ALM's REST API to AI coding agents (Claude Code, Cursor, etc.) via the [Model Context Protocol](https://modelcontextprotocol.io).

## Status

Codemode migration branch.

The checked-in runtime is still the older Bun-based multi-tool server. The target architecture for this branch is a Deno-based codemode server with one public `code` tool, top-level resources, and an internal combined tool surface of curated tools plus generated raw `api.*` tools.

See:

- [docs/product-direction.md](/Users/tomford/code/projects/polarionmcp/docs/product-direction.md)
- [docs/codemode-plan.md](/Users/tomford/code/projects/polarionmcp/docs/codemode-plan.md)

## Setup

```bash
nix develop
bun install
cp .env.example .env   # then fill in your Polarion URL and token
```

`.envrc` is configured for `use flake`.

## Usage

Run in HTTP mode:

```bash
bun run src/server.ts
```

Run in stdio mode:

```bash
bun run src/server.ts --stdio
```

Or add to your MCP client config (e.g. `.mcp.json`):

```json
{
  "mcpServers": {
    "polarion": {
      "type": "stdio",
      "command": "bun",
      "args": ["run", "src/server.ts", "--stdio"],
      "env": {
        "POLARION_BASE_URL": "https://polarion.example.com/polarion/rest/v1",
        "POLARION_ACCESS_TOKEN": "your-token"
      }
    }
  }
}
```

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `POLARION_BASE_URL` | yes | Full base URL, e.g. `https://polarion.example.com/polarion/rest/v1` |
| `POLARION_ACCESS_TOKEN` | stdio only | Bearer token for local stdio mode |
| `PORT` | HTTP only | Listen port for HTTP mode. Defaults to `8080` |

In HTTP mode, each client must send its own `Authorization: Bearer ...` header. TLS/HTTPS is expected to terminate at an ingress, reverse proxy, or load balancer in front of the container; this server listens on plain HTTP inside the deployment boundary.

## Tools

| Tool | Description |
|------|-------------|
| `list_projects` | List projects (paginated, queryable) |
| `list_work_items` | List work items in a project (paginated, filterable, field selection) |
| `get_work_item` | Get a single work item with full detail |
| `update_work_item` | Sparse PATCH of work item attributes, with optional workflow action |
| `list_documents` | List documents in a project |
| `get_document` | Get a single document by space and name |
| `list_linked_work_items` | List outgoing links from a work item |
| `get_fields_metadata` | Discover available fields for a resource type |
| `get_enum_options` | Get available enum values for a field (e.g. severity, priority) |
| `get_workflow_actions` | Get available workflow transitions for a work item |
| `polarion_api_help` | Discover curated and generic read operations by keyword or resource type |
| `polarion_api_read` | Execute an allowlisted read-only Polarion GET operation by `operation_id` |

All list-style endpoints support pagination (`page_size`, `page_number`) and field selection (`fields`).

Default pagination is intentionally narrow:

- default `page_size`: `20`
- maximum `page_size`: `50`

## MCP Resources

The server exposes fetchable resources for guidance instead of overloading tool descriptions:

| Resource URI | Description |
|--------------|-------------|
| `polarion://guides/query-syntax` | Polarion query syntax and filtering guide |
| `polarion://guides/mcp-usage` | Tool selection, pagination, and safety guidance |

## Usage Guidance

Preferred workflow:

1. Use a curated tool when one exists
2. If unsure which operation fits, call `polarion_api_help`
3. Use `polarion_api_read` only when no curated tool fits
4. Fetch incrementally with pagination and sparse fields

Generic read behavior:

- keyed by `operation_id`, not arbitrary paths
- blocked for binary/admin-like endpoints
- advanced global/all-project reads require explicit `scope_mode: "all"`
- oversized responses may be truncated with continuation hints

## Generated API Client

Types are generated from the bundled OpenAPI spec (`polarionrest.json`) using `openapi-typescript`. The runtime client uses `openapi-fetch` for fully typed requests.

To regenerate types after updating the spec:

```bash
bun run generate
```

## Tests

```bash
bun test
```

## License

MIT
