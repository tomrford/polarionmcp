# polarion-mcp

MCP server that exposes Polarion ALM's REST API to AI coding agents (Claude Code, Cursor, etc.) via the [Model Context Protocol](https://modelcontextprotocol.io).

Works with any Polarion instance — reads projects, work items, documents, linked items, field metadata, enums, and workflow actions. Also supports sparse PATCH updates on work items.

## Setup

```bash
bun install
cp .env.example .env   # then fill in your Polarion URL and token
```

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

All list endpoints support pagination (`page_size`, `page_number`) and field selection (`fields`).

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
