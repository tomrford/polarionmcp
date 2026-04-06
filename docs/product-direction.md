# Product Direction

## Status

This branch is migrating the Polarion MCP from a many-tool Bun server into a codemode-first Deno server.

The target product is a power tool, initially pointed at demo or sandbox data.

## Public Surface

The final public MCP should expose:

- one `code` tool
- lightweight top-level resources for guidance

The user-facing model should not need to reason about separate curated and raw MCP servers.

## Internal Tool Surface

Inside the codemode sandbox, the model should have access to one combined tool surface:

- curated tools for common Polarion workflows
- raw `api.*` tools generated from a trimmed OpenAPI surface
- search/help over the raw API namespace

Curated and raw tools must be callable in the same execution so code can mix them freely.

## Write Posture

Writes are allowed in v1.

Boundaries:

- auth stays host-side
- the sandbox never sees credentials
- the allowed surface comes from trim policy, not from a read-only restriction

## OpenAPI Policy

The repo keeps the full upstream spec and generates the usable surface from policy.

The generator pipeline should:

1. load the full spec
2. apply allow/block policy
3. emit a trimmed spec artifact
4. emit generated TS types/client from the trimmed spec
5. emit the raw MCP registry from the trimmed spec

This keeps the surface reversible as policy changes over time.

## Included And Excluded Areas

Included:

- approved reads and writes
- `jobs`

Excluded by default:

- admin-like routes
- license routes
- avatar/icon/binary content routes
- export/download routes
- other low-signal or high-risk endpoints that do not fit the product

## Batch Direction

`batch_id` orchestration is obsolete in this design.

Codemode should replace the need for query-handle state, fingerprint caches, and most batch orchestration. If we later need a true bulk primitive for throughput, that should be added directly from the real API surface rather than reviving the old `batch_id` design.
