# polarion-mcp

MCP server that exposes Polarion ALM's REST API to AI coding agents through
[Model Context Protocol](https://modelcontextprotocol.io).

Rather than mapping each Polarion endpoint to its own MCP tool, the server exposes a
code-mode interface: agents discover operations with `search`, then compose calls freely
inside a single `code` execution. This keeps the public tool surface small while the
generated Polarion operation coverage stays broad.

Background on the code-mode pattern:

- [Cloudflare Code Mode article](https://blog.cloudflare.com/code-mode/)
- [`@cloudflare/codemode`](https://www.npmjs.com/package/@cloudflare/codemode) package (used in this project)

## How It Works

The server exposes three MCP tools:

- **`search`** — fuzzy lookup over the callable Polarion operation catalog. Use it to
  discover function names, parameter shapes, and return types.
- **`code`** — execute JavaScript against the internal `codemode.*` surface.
- **`read_attachment`** — read a specific Polarion attachment found by `code`.
  It accepts the attachment `links.content` URL, or `resourceType` plus the full
  JSON:API attachment `id`, and returns supported image or UTF-8 text content.

A typical agent flow:

1. Call `search` to find the right operation and its signature.
2. Call `code` with a script that uses `codemode.<operationId>(...)`.
3. Call `read_attachment` when the script returns attachment metadata whose content
   should be inspected.

```js
(async () => {
  return await codemode.getProjects({});
})();
```

More examples:

```js
codemode.getWorkItems({ projectId: "PRJ", query: "type:requirement" })
codemode.patchWorkItem({ projectId: "PRJ", workItemId: "REQ-1", body: { ... } })
```

The internal `codemode.*` operations are generated from the checked-in Polarion OpenAPI
spec. Operation names match the upstream `operationId`. An allowlist controls which
operations are exposed — see [docs/allowlist.md](docs/allowlist.md) for the full
inventory.

### Design Notes

- Generated list operations fetch all Polarion pages and return full collections.
- Request shapes are tuned for scripting: path params and query params sit at top level;
  request payload goes under `body`.
- Generated reads return stable top-level envelopes: collections use
  `{ kind: "collection", items, ... }`, single resources use
  `{ kind: "resource", item, ... }`, and `204` writes normalize to
  `{ ok: true }`.
- Only the final `code` result returned to the MCP client may be truncated.
- Attachment content routes stay outside `codemode`; `read_attachment` validates
  Polarion attachment content URLs, transcodes PNG and JPEG attachments to lossless
  WebP, and returns inline images only when the serialized MCP result fits the
  configured inline budget.
- Auth stays host-side — the sandboxed code path never receives credentials.

## Client Configuration

Configure your MCP client or agent harness to connect to the server.

### stdio

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

### Streamable HTTP

```json
{
  "mcpServers": {
    "polarion": {
      "type": "streamable-http",
      "url": "http://localhost:8080/mcp",
      "headers": {
        "Authorization": "Bearer your-token"
      }
    }
  }
}
```

The HTTP endpoint is stateless and returns JSON-RPC responses directly. It does
not issue or require `Mcp-Session-Id`; `GET` and `DELETE` requests to `/mcp`
return `405 Method Not Allowed`.

## Running the Server

### Setup

```bash
nix develop        # optional — sets up the Deno toolchain
cp .env.example .env
# fill in local defaults, or set the same variables in your shell/container UI
```

### Environment

| Variable                                  | Required   | Description                                                           |
| ----------------------------------------- | ---------- | --------------------------------------------------------------------- |
| `POLARION_BASE_URL`                       | yes        | Full base URL, e.g. `https://polarion.example.com/polarion/rest/v1`   |
| `POLARION_ACCESS_TOKEN`                   | stdio only | Bearer token for local stdio mode                                     |
| `PORT`                                    | no         | HTTP listen port (default `8080`)                                     |
| `REST_PAGE_SIZE`                          | no         | Page size for generated collection reads; Polarion default when unset |
| `FETCH_CONCURRENCY_COUNT`                 | no         | Concurrent page fetches for generated collection reads (default `1`)  |
| `READ_ATTACHMENT_INLINE_RESULT_MAX_BYTES` | no         | Serialized inline image result budget (default `1000000`)             |

### Transports

Start in HTTP mode:

```bash
deno task start
```

Start in stdio mode:

```bash
deno task start:stdio
```

HTTP mode serves the MCP endpoint at `/mcp` and unauthenticated health checks at
`GET /healthz` and `GET /readyz`. Callers authenticate each MCP request with an
`Authorization: Bearer <token>` header. In stdio mode the server reads
`POLARION_ACCESS_TOKEN` from the environment instead.

## Deployment

Build and run the container with Docker Compose:

```bash
docker compose up -d --build
```

Provide `POLARION_BASE_URL` through the Compose environment. `PORT`,
`REST_PAGE_SIZE`, and `FETCH_CONCURRENCY_COUNT` are optional.
Use `GET /healthz` or `GET /readyz` for container or load-balancer probes.

## Code Generation

The generator reads the full upstream spec from
[polarionrest.json](polarionrest.json), trims it through the allowlist, and writes:

- [generated/polarion.trimmed.json](generated/polarion.trimmed.json) — trimmed OpenAPI spec
- [generated/polarion.ts](generated/polarion.ts) — TypeScript client
- [src/generated/operations.ts](src/generated/operations.ts) — operation registry
- [docs/allowlist.md](docs/allowlist.md) — allowed-vs-blocked inventory

Regenerate with:

```bash
deno task generate
```

## Development

```bash
deno task fmt:check   # formatting
deno task lint        # linting
deno task test        # tests
deno task check       # type-check
```

## License

MIT
