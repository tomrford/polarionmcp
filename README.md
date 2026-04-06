# polarion-mcp

MCP server that exposes Polarion ALM's REST API to AI coding agents (Claude Code, Cursor, etc.) via
the [Model Context Protocol](https://modelcontextprotocol.io).

## Status

Codemode migration branch.

The checked-in runtime is now a Deno-based codemode server rooted under `src/`. The current vertical
slice exposes one public `code` tool, with the existing curated Polarion tools plus
`polarion_api_help` and `polarion_api_read` living behind the codemode sandbox. Generated raw
`api.*` tools are the next step, not the current state.

See:

- [docs/product-direction.md](/Users/tomford/code/projects/polarionmcp/docs/product-direction.md)
- [docs/codemode-plan.md](/Users/tomford/code/projects/polarionmcp/docs/codemode-plan.md)

## Setup

```bash
nix develop
cp .env.example .env   # then fill in your Polarion URL and token
```

`.envrc` is configured for `use flake`.

## Usage

Run in HTTP mode:

```bash
deno task start
```

Run in stdio mode:

```bash
deno task start:stdio
```

Or add to your MCP client config (e.g. `.mcp.json`):

```json
{
  "mcpServers": {
    "polarion": {
      "type": "stdio",
      "command": "deno",
      "args": ["task", "start:stdio"],
      "env": {
        "POLARION_BASE_URL": "https://polarion.example.com/polarion/rest/v1",
        "POLARION_ACCESS_TOKEN": "your-token"
      }
    }
  }
}
```

## Configuration

| Variable                | Required   | Description                                                         |
| ----------------------- | ---------- | ------------------------------------------------------------------- |
| `POLARION_BASE_URL`     | yes        | Full base URL, e.g. `https://polarion.example.com/polarion/rest/v1` |
| `POLARION_ACCESS_TOKEN` | stdio only | Bearer token for local stdio mode                                   |
| `PORT`                  | HTTP only  | Listen port for HTTP mode. Defaults to `8080`                       |

In HTTP mode, each client must send its own `Authorization: Bearer ...` header. TLS/HTTPS is
expected to terminate at an ingress, reverse proxy, or load balancer in front of the container; this
server listens on plain HTTP inside the deployment boundary.

## Public Tool

| Tool   | Description                                                            |
| ------ | ---------------------------------------------------------------------- |
| `code` | Execute JavaScript codemode against the internal Polarion tool surface |

Inside `code`, the current internal tool surface includes:

- curated tools: `list_projects`, `list_work_items`, `get_work_item`, `update_work_item`,
  `list_documents`, `get_document`, `list_linked_work_items`, `get_fields_metadata`,
  `get_enum_options`, `get_workflow_actions`, `add_work_item_comment`, `add_work_item_link`,
  `update_work_item_link`, `remove_work_item_link`
- discovery/escape hatch: `polarion_api_help`, `polarion_api_read`

All list-style endpoints support pagination (`page_size`, `page_number`) and field selection
(`fields`).

Default pagination is intentionally narrow:

- default `page_size`: `20`
- maximum `page_size`: `50`

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

Types are generated from the bundled OpenAPI spec at
[`polarionrest.json`](/Users/tomford/code/projects/polarionmcp/polarionrest.json) using
`openapi-typescript`. The runtime client uses `openapi-fetch` for fully typed requests.

To regenerate types after updating the spec:

```bash
deno task generate
```

## Tests

```bash
deno task test
```

## License

MIT
