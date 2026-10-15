# polarion-mcp

MCP server that exposes Polarion ALM's REST API to AI coding agents through
[Model Context Protocol](https://modelcontextprotocol.io).

The public default surface is small: agents discover operations with `search`,
compose calls inside `code`, and read attachment bytes with `read_attachment`.
The generated Polarion operation coverage stays broad. Clients that already
sandbox tools can opt out of Code Mode with `?codemode=false` on the same `/mcp`
URL. That switch lists the curated Polarion `operationId` tools plus
`read_attachment`. It does not expose raw OpenAPI.

Background on the code-mode pattern:

- [Cloudflare Code Mode article](https://blog.cloudflare.com/code-mode/)
- Official Cloudflare API MCP (`cloudflare/mcp`) — query-param composition and
  Dynamic Worker hosting

## How it works

- **`search`** — fuzzy lookup over the callable Polarion operation catalog.
- **`code`** — execute JavaScript against the internal `codemode.*` surface in a
  fresh Dynamic Worker isolate. Tool calls RPC back into the parent, which runs
  the curated Polarion operations. The child isolate never sees the Bearer token.
- **`read_attachment`** — read a Polarion attachment found by `code`. It accepts
  the attachment `links.content` URL, or `resourceType` plus the full JSON:API
  attachment `id`, and returns supported image or UTF-8 text content.

A typical agent flow:

1. Call `search` to find the right operation and its signature.
2. Call `code` with a script that uses `codemode.<operationId>(...)`.
3. Call `read_attachment` when the script returns attachment metadata whose
   content should be inspected.

```js
async () => {
  return await codemode.getProjects({});
}
```

The internal `codemode.*` operations are generated from the checked-in Polarion
OpenAPI spec. Operation names match the upstream `operationId`. An allowlist
controls which operations are exposed — see [docs/allowlist.md](docs/allowlist.md).

### Design notes

- Generated list operations follow `links.next` until it is absent. When `meta.totalCount` is present, the remaining `page[number]` requests run in parallel. A page cap, item cap, or unreadable next page returns the items already collected with `incomplete: true` and that next link.
- Request shapes are tuned for scripting: path params and query params sit at
  top level; request payload goes under `body`.
- Generated reads return stable top-level envelopes: collections use
  `{ kind: "collection", items, ... }`, single resources use
  `{ kind: "resource", item, ... }`, and `204` writes normalize to `{ ok: true }`.
- Only the final `code` result returned to the MCP client may be truncated.
- Attachment content routes stay outside `codemode`. `read_attachment` validates
  Polarion attachment content URLs, compares PNG/JPEG originals against lossless
  WebP using the complete serialized reply size, and returns the smaller result
  when it fits the configured inline budget. Image dimensions and visible pixels
  are preserved; oversized images return metadata.
- Auth stays host-side. The sandboxed `code` path never receives credentials.

## Client configuration

HTTP mode is the only transport. Connect with Streamable HTTP:

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

Opt out of Code Mode on the same URL:

```text
http://localhost:8080/mcp?codemode=false
```

The HTTP endpoint is stateless and returns JSON-RPC responses. Modern MCP requests
receive JSON; the SDK serves older protocol revisions over SSE. It does
not issue or require `Mcp-Session-Id`. `GET` and `DELETE` requests to `/mcp`
return `405 Method Not Allowed`.

## Running the server

Docker Compose is the deployment method:

```bash
cp .env.example .env
# set POLARION_BASE_URL
docker compose up -d --build
```

Local development uses Node 22.9 or newer and the same supervised workerd runtime:

```bash
pnpm install
cp .env.example .env
pnpm dev
```

### Environment

| Variable | Required | Description |
| --- | --- | --- |
| `POLARION_BASE_URL` | yes | Full base URL, e.g. `https://polarion.example.com/polarion/rest/v1` |
| `POLARION_GUIDELINES` | no | Server instructions. The baked-in default is used when unset |
| `REST_PAGE_SIZE` | no | Page size for generated collection reads; Polarion default when unset |
| `FETCH_CONCURRENCY_COUNT` | no | Parallel `page[number]` fetches when a collection includes `meta.totalCount` (default `1`). Without `totalCount`, pages are followed via `links.next` one at a time |
| `READ_ATTACHMENT_INLINE_RESULT_MAX_BYTES` | no | Serialized inline image result budget (default `1000000`) |

HTTP mode serves `/mcp` plus unauthenticated `GET /healthz` and `GET /readyz`.
Callers authenticate each MCP request with `Authorization: Bearer <token>`.

The Node launcher keeps four `workerd serve` processes running. Each process
handles one MCP request at a time and loads a fresh Dynamic Worker for each
`code` call. A healthy process returns to the pool after the complete response. After 100
completed requests, the launcher replaces that process to reclaim native memory.
The current response finishes before replacement. This local policy limits the
memory accumulation observed in sustained tests.

Up to 32 additional requests wait in a FIFO queue. The 30-second deadline starts
when a request reaches the launcher and covers queue time, startup, Polarion
calls and response delivery. An expired request receives `504` if the response
has not started. A full queue returns `503` with `Retry-After: 1`.

A timeout, client disconnection during execution or failed worker causes the
launcher to kill and replace that process. It never retries the operation.
Polarion writes already sent may have completed. Queued requests that disconnect
or expire leave the queue without running. All MCP requests share the four
slots, including catalog and direct-tool requests. Node health checks remain
responsive when all slots are busy. Failed host startups retry after a one-second
pause. `/readyz` returns `503` when no host is ready.

Completion logs include `outcome`, `queueMs`, `workerMs`, `durationMs` and the
worker PID. These are elapsed times, not CPU measurements. Queue time includes
any wait for a host to start. Worker time includes response delivery. Responses
also include queue time in the `Server-Timing` header. Logs omit request bodies
and authorization headers.

This external watchdog is required because standalone workerd does not enforce
CPU limits. Both `pnpm start` and Docker use it. Running Wrangler or workerd
directly bypasses the watchdog.

The parent can reach private Polarion addresses. The Dynamic Worker has no direct
network access and receives only the curated operation dispatcher.

## Code generation

The generator reads the full upstream spec from
[polarionrest.json](polarionrest.json), trims it through the allowlist, and writes:

- [src/generated/operations.ts](src/generated/operations.ts) — operation registry
- [docs/allowlist.md](docs/allowlist.md) — allowed-vs-blocked inventory

Regenerate with:

```bash
pnpm generate
```

Generated files retain the generator's formatting. The formatter excludes the
operation registry so regeneration produces reviewable semantic diffs.

## Development

```bash
pnpm fmt:check
pnpm lint
pnpm test
pnpm check
```

## License

MIT
