Default to using Deno in this repo.

## Repo Shape

- MCP server for Polarion ALM
- Public surface: top-level `search` and `code`
- `code` executes JavaScript against generated `codemode.*` operations
- Generated operation names match Polarion OpenAPI `operationId`
- Allowed API surface is defined by the checked-in allowlist; see `docs/allowlist.md`

## Runtime And Auth

- Start HTTP mode with `deno task start`
- Start stdio mode with `deno task start:stdio`
- HTTP mode serves stateless Streamable HTTP at `/mcp` with JSON responses, plus unauthenticated `GET /healthz` and `GET /readyz`
- HTTP mode expects caller `Authorization: Bearer <token>` headers
- stdio mode reads `POLARION_ACCESS_TOKEN` from env
- Required base config: `POLARION_BASE_URL`
- Optional pagination config: `REST_PAGE_SIZE`, `FETCH_CONCURRENCY_COUNT`
- Start tasks load `.env`
- Keep auth host-side; sandboxed code paths should not read credentials directly

## Commands

- Use `deno task <name>` for repo tasks
- Regenerate generated artifacts with `deno task generate`
- Full gate: `deno task fmt:check`, `deno task lint`, `deno task test`, `deno task check`
