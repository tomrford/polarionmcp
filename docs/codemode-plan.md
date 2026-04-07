# Codemode Plan

## Current Architecture

The repo now targets this shape:

- Deno host runtime
- top-level `search` and `code` MCP tools
- Cloudflare codemode-style execution inside `code`
- generated Polarion operation surface exposed as `codemode.<operationId>(...)`

The key implementation choice is to generate the callable surface from a trimmed OpenAPI spec
instead of maintaining a large hand-written curated layer.

## Implemented Direction

Implemented or in-progress decisions:

- local fork of the codemode MCP wrapper so request-scoped auth can be bridged into inner tool calls
- top-level `search` over the real callable catalog
- compact `code` description instead of an oversized inline catalog
- generated internal operations only
- exact `operationId` naming
- lightly tuned request shapes
- generic host request adapter
- explicit allowlist-driven spec trimming

## Generation Model

The generator owns the public internal contract.

Pipeline:

1. read full Polarion spec from
   [polarionrest.json](/Users/tomford/code/projects/polarionmcp/polarionrest.json)
2. filter it through the allowlist in
   [src/openapi/allowed-operations.ts](/Users/tomford/code/projects/polarionmcp/src/openapi/allowed-operations.ts)
3. emit
   [generated/polarion.trimmed.json](/Users/tomford/code/projects/polarionmcp/generated/polarion.trimmed.json)
4. regenerate
   [generated/polarion.ts](/Users/tomford/code/projects/polarionmcp/generated/polarion.ts)
5. emit
   [src/generated/operations.ts](/Users/tomford/code/projects/polarionmcp/src/generated/operations.ts)

The runtime then registers that generated registry as MCP tools and adapts tuned request shapes back
to exact HTTP wire requests.

## Request And Response Shape

Generated requests are lightly tuned:

- path params at top-level
- ordinary query params at top-level
- `page[size]` and `page[number]` normalized to `page: { size, number }`
- request payload under top-level `body`

Generated responses stay close to the raw API:

- preserve JSON API envelopes
- preserve operation-native response bodies
- normalize `204` to `{ ok: true }`

## What This Replaced

No longer part of the plan:

- curated internal workflow tools
- `polarion_api_help`
- `polarion_api_read`
- GET-only read-policy/read-catalog plumbing
- any assumption that public surface should stay `code`-only

## Near-Term Follow-Ups

Still worth iterating after the generated base lands:

- shrink `code` guidance further if it still costs too much context
- split `search` into `list_tools` plus `get_tool_info` if discovery payloads become noisy
- use real agent feedback to decide whether a separate project/context discovery tool is justified
- tune the allowlist as we learn which routes are genuinely useful

## Success Criteria

The generated migration is successful if:

- `search` can reliably surface the right operation with partial user intent
- `code` can call generated read and write operations end-to-end
- request-scoped auth works for both HTTP and stdio entry paths
- expanding the toolset is mainly allowlist churn, not new handwritten runtime code
