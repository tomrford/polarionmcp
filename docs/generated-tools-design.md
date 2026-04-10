# Generated Tools Design

## Purpose

This document captures the current generated-tool contract for the codemode server.

## Public Surface

Top-level MCP tools:

- `search`
- `code`

`search` is discovery only. `code` is execution only.

Inside `code`, the model calls generated Polarion operations through `codemode.*`.

If the final `code` result is too large, truncation happens only when returning that final value to
the agent. The generated Polarion calls inside the script still run against the full fetched data.

## Internal Surface

The internal surface is generated-only:

- exact OpenAPI `operationId` names
- no curated wrappers
- no `api.*` namespace
- no generic help/read wrapper

Examples:

- `codemode.getProjects(...)`
- `codemode.getWorkItems(...)`
- `codemode.patchWorkItem(...)`

## Trim Policy

The full checked-in Polarion spec is reduced through a single explicit allowlist.

Properties:

- allowed operations become generated tools
- expanding the surface should usually mean editing the allowlist only
- initial scope is product-domain-only and broad enough for sandbox/demo evaluation

Current included domains:

- projects
- jobs
- workitems
- documents
- read-only metadata
- plans
- testruns

Current excluded domains:

- user/global identity
- admin or license routes
- project-admin and project-metadata mutation routes
- export/download routes
- avatar/icon/binary content routes
- other low-signal infrastructure endpoints

## Request Shapes

Generated input schemas are lightly tuned at generation time:

- path params promoted to top-level
- ordinary query params promoted to top-level
- bracketed pagination retained only in wire adaptation; generated tools walk pages internally
- request payload under top-level `body`
- operation-native names preserved, for example `workflowAction`

This is intentionally not a curated normalization layer.

## Response Shapes

Generated responses stay close to the Polarion API:

- preserve JSON API envelopes like `data`, `meta`, `links`, `included`
- preserve operation-native JSON payloads
- normalize `204 No Content` to `{ ok: true }`
- serialize successful generated-tool payloads as compact JSON

## Search Contract

Top-level `search` should stay compact.

Per-match payload:

- `name`
- `callable`
- `resource_group`
- `description`
- `required_params`
- `optional_params`
- `input_summary`
- `output_summary`
- `annotations`

`search` is fuzzy over:

- tool names
- callable names
- descriptions
- parameter names
- parameter descriptions

## Generated Registry

The generated registry is emitted at
[src/generated/operations.ts](/Users/tomford/code/projects/polarionmcp/src/generated/operations.ts).

Each entry carries enough metadata for:

- MCP registration
- request adaptation back to exact HTTP wire format
- compact discovery via `search`
- output-shape summaries

Registry fields:

- `name`
- `method`
- `pathTemplate`
- `description`
- `resourceGroup`
- `annotations`
- `input`
- `wire`
- `output`
- `meta`

## Runtime Adapter

The generated layer uses a generic host-side `fetch()` adapter.

Safety boundary:

- generated input schema validation
- request adaptation from tuned shape to exact wire shape
- host-side auth injection
- shared HTTP error handling

This keeps the runtime uniform across generated operations and avoids a handwritten dispatch table
per route.

## Tool Annotations

Generated tools derive annotations from HTTP method:

- `GET`: read-only, non-destructive, idempotent
- `POST`: non-read-only, destructive, non-idempotent
- `PATCH`: non-read-only, destructive, non-idempotent
- `DELETE`: non-read-only, destructive, non-idempotent for now
- all generated tools: open-world

## Generator Pipeline

`deno task generate` should:

1. load the full upstream spec
2. apply the allowlist
3. write the trimmed spec artifact
4. regenerate `generated/polarion.ts`
5. emit the generated registry module

The trimmed spec is the source of truth for:

- input schemas
- query/path/body parameter types
- success response schemas
- descriptions and parameter locations

The generated TypeScript output is primarily for compile-time/runtime typing in handwritten host
code.

## Deferred Work

Not part of the current contract:

- a separate project/context discovery helper
- splitting `search` into `list_tools` plus `get_tool_info`
- heavier request normalization beyond the current light tuning
- reintroducing curated wrappers unless real workflow value justifies them
- richer write-body discovery in `search` likely shape: preserve shallow object body properties
  during generation, then expose a compact `body_summary` or richer `input_summary` instead of only
  saying that `body` exists
- structured handling for composite relationship ids likely shape: keep the raw id, then add
  targeted post-processing by resource group or route to expose parsed relationship components where
  it clearly improves workflows
