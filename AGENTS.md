Default to using pnpm and Node in this repo.

## Repo Shape

- MCP server for Polarion ALM, hosted on workerd
- Public default surface: `search`, `code`, `read_attachment`
- `POST /mcp?codemode=false` lists curated Polarion `operationId` tools plus `read_attachment`
- `code` executes JavaScript in a Dynamic Worker isolate against generated `codemode.*` operations
- Generated operation names match Polarion OpenAPI `operationId`
- Allowed API surface is defined by the checked-in allowlist; see `docs/allowlist.md`

## Runtime And Auth

- Deploy with Docker Compose (`workerd serve`)
- Local development: `pnpm dev` (Wrangler)
- HTTP mode serves stateless Streamable HTTP at `/mcp` with JSON responses, plus unauthenticated `GET /healthz` and `GET /readyz`
- HTTP mode expects caller `Authorization: Bearer <token>` headers
- Required base config: `POLARION_BASE_URL`
- Optional: `POLARION_GUIDELINES`, `REST_PAGE_SIZE`, `FETCH_CONCURRENCY_COUNT`, `READ_ATTACHMENT_INLINE_RESULT_MAX_BYTES`
- Keep auth host-side; sandboxed code paths should not read credentials directly

## Commands

- Use `pnpm <name>` for repo tasks
- Regenerate generated artifacts with `pnpm generate`
- Full gate: `pnpm fmt:check`, `pnpm lint`, `pnpm test`, `pnpm check`
