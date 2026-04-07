# Product Direction

## Current Product Shape

This server is now a codemode-first Polarion power tool.

Public MCP surface:

- top-level `search` for discovery
- top-level `code` for execution

Internal codemode surface:

- generated Polarion operations only
- exact OpenAPI `operationId` names
- no curated wrappers
- no generic help/read escape hatch

The user-facing model should discover via `search`, then script against `codemode.*` inside `code`.

## Why This Shape

The product is optimizing for:

- fewer model round-trips
- loops, joins, and conditional workflows inside one execution
- broad Polarion coverage from one trimmed API surface
- low maintenance cost when the allowed surface changes

That pushes the design toward:

- one trimmed OpenAPI source of truth
- generated callable operations instead of hand-maintained curated wrappers
- one generic host request adapter
- host-side auth only

## Write Posture

Writes are allowed.

Current safety boundary:

- auth stays host-side
- the codemode sandbox never sees credentials
- the allowed surface comes from the explicit allowlist
- this server is currently aimed at sandbox/demo data first

Read-only or role-based policy can be layered on later, but it is not part of the current product
contract.

## Discovery Direction

`search` should stay concise.

Current purpose:

- fuzzy lookup over the real callable catalog
- compact input-shape summaries
- compact output-shape summaries

If result payloads start bloating context, the likely v2 is splitting discovery into `list_tools`
plus `get_tool_info`.

## Surface Policy

The repo keeps:

- the full upstream Polarion spec
- a checked-in trimmed spec artifact
- generated TS types from the trimmed spec
- a generated operation registry used for MCP registration and request adaptation

Initial allowed scope is product-domain focused and intentionally broad enough for sandbox/demo
learning:

- projects
- jobs
- workitems
- documents
- read-only metadata and enum/workflow discovery routes
- plans
- testruns

Excluded by default:

- user/global identity routes
- admin or license routes
- project-admin and project-metadata mutation routes
- export/download routes
- avatar/icon/binary content routes
- other low-signal infrastructure endpoints

## Obsolete Directions

These are no longer part of the product plan:

- `batch_id` orchestration
- query-handle lifecycle state
- fingerprint caches
- curated-plus-raw mixed internal surfaces
- generic `polarion_api_help` / `polarion_api_read` escape hatches

If we later need higher-level abstractions, they should be added on top of the generated base rather
than by reviving the old architecture.
