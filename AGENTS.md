Default to using pnpm and Node in this repo.

## Repo Shape

- MCP server for Polarion ALM, hosted on workerd
- Public default surface: `search`, `code`, `read_attachment`
- `POST /mcp?codemode=false` lists curated Polarion `operationId` tools plus `read_attachment`
- `code` executes JavaScript in a Dynamic Worker isolate against generated `codemode.*` operations
- Generated operation names match Polarion OpenAPI `operationId`
- Allowed API surface is defined by the checked-in allowlist; see `docs/allowlist.md`

## Runtime And Auth

- Deploy with Docker Compose (Node supervises four reusable workerd processes, one MCP request per process)
- Hosts recycle between requests after 100 completed POSTs to reclaim native memory
- Local development: `pnpm dev` (same supervisor; Node 22.9+)
- All MCP requests have a 30-second wall-clock deadline including queue time; four run concurrently and up to 32 wait in FIFO order
- Do not serve workerd or Wrangler directly: standalone workerd does not enforce CPU limits
- HTTP mode serves stateless Streamable HTTP at `/mcp` with JSON responses for every protocol revision (no SSE), plus unauthenticated `GET /healthz` and `GET /readyz`
- HTTP mode expects caller `Authorization: Bearer <token>` headers
- Required base config: `POLARION_BASE_URL`
- Optional: `POLARION_GUIDELINES`, `REST_PAGE_SIZE`, `FETCH_CONCURRENCY_COUNT`, `READ_ATTACHMENT_INLINE_RESULT_MAX_BYTES`
- Keep auth host-side; sandboxed code paths should not read credentials directly

## Commands

- Use `pnpm <name>` for repo tasks
- Regenerate generated artifacts with `pnpm generate`
- The generated operation registry is excluded from formatting; workerd config is generated under `dist/`
- `pnpm test` includes real-process tests against a local mock Polarion endpoint
- Full gate: `pnpm fmt:check`, `pnpm lint`, `pnpm test`, `pnpm check`
