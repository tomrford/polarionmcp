# polarion-mcp

MCP server that exposes Polarion ALM's REST API to AI coding agents through
[Model Context Protocol](https://modelcontextprotocol.io).

## Status

Current runtime:

- Deno host under `src/`
- public MCP surface: top-level `search` and `code`
- internal codemode surface: generated Polarion operations named by exact OpenAPI `operationId`

This is now a raw-first codemode server. The old curated tools and generic help/read escape hatches
are gone.

See:

- [docs/product-direction.md](/Users/tomford/code/projects/polarionmcp/docs/product-direction.md)
- [docs/generated-tools-design.md](/Users/tomford/code/projects/polarionmcp/docs/generated-tools-design.md)

## Setup

```bash
nix develop
cp .env.example .env
```

Fill in:

- `POLARION_BASE_URL`
- `POLARION_ACCESS_TOKEN` for local stdio usage

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

Example MCP client config:

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

In HTTP mode, callers must send their own `Authorization: Bearer ...` header. Auth stays host-side;
the codemode sandbox never receives credentials directly.

## Public MCP Surface

Top-level tools:

- `search`: fuzzy discovery over the real callable Polarion catalog
- `code`: execute JavaScript against the internal `codemode.*` Polarion surface

Typical flow:

1. call `search` if you need to discover function names, parameter shapes, or return shapes
2. call `code`
3. inside `code`, use `codemode.<operationId>(...)`

Example:

```js
(async () => {
  return await codemode.getProjects({});
});
```

## Internal Generated Surface

The internal codemode surface is generated from a trimmed checked-in OpenAPI spec.

Properties:

- generated operation names use the exact OpenAPI `operationId`
- request shapes are lightly tuned for scripting
- path params are promoted to top-level
- ordinary query params are promoted to top-level
- pagination is normalized to `page: { size, number }`
- request bodies live under top-level `body`
- responses stay close to the raw API
- `204` responses normalize to `{ ok: true }`

Examples:

- `codemode.getProjects({})`
- `codemode.getWorkItems({ projectId: "PRJ", query: "type:requirement" })`
- `codemode.patchWorkItem({ projectId: "PRJ", workItemId: "REQ-1", body: { ... } })`

## Generation Pipeline

The generator task:

1. loads the full upstream spec from
   [polarionrest.json](/Users/tomford/code/projects/polarionmcp/polarionrest.json)
2. trims it through an explicit allowlist
3. writes
   [generated/polarion.trimmed.json](/Users/tomford/code/projects/polarionmcp/generated/polarion.trimmed.json)
4. regenerates
   [generated/polarion.ts](/Users/tomford/code/projects/polarionmcp/generated/polarion.ts)
5. emits the generated operation registry at
   [src/generated/operations.ts](/Users/tomford/code/projects/polarionmcp/src/generated/operations.ts)

Run it with:

```bash
deno task generate
```

## Tests

```bash
deno task test
deno task check
```

## License

MIT
