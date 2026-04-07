# Codemode Friction Log

Observed friction from an LLM client using the `code` MCP tool.

## 1. Tool Discovery — No Catalog in Description

The `code` tool description mentions "curated Polarion tools" but never lists them.
I receive one tool (`code`) with a free-text description; no structured schema for the
inner functions. I had to:

- Guess `codemode.*` namespace (now fixed: bare functions)
- Guess tool names (`list_work_item_links` vs actual `list_linked_work_items`)
- Call `polarion_api_help()` to discover names — but didn't know _it_ existed either

**Fix options:**
- Include a compact function catalog in the `code` tool description (name + required params)
- Make functions enumerable in the sandbox (`Object.keys()` or a `help()` built-in)
- Both: static catalog for zero-round-trip, runtime introspection as fallback

## 2. Parameter Schemas Invisible

No way to learn optional params or constraints without trial-and-error:

- `page_size` max 50 — discovered only via zod validation error
- `get_fields_metadata` requires `resource_type` not `target_type` — discovered via error
- `list_documents` items have no `attributes` block — different shape from work items
- Optional fields like `fields`, `query`, `page_number` — invisible until guessed

**Fix options:**
- Include param schemas (or at least required + key optional params) in the catalog
- Return schema info from a `help("tool_name")` call

## 3. polarion_api_read Response Nesting

`polarion_api_read` wraps the raw JSON:API response inside `{ operation_id, path, policy_mode, data }`.
JSON:API itself uses a `data` key, so the actual items are at `result.data.data` — double nesting.

Tripped me up: `(result.data || []).map(...)` fails because `result.data` is an object, not an array.

**Fix:** Will be less of an issue when escape hatch moves to `api.*` typed functions.
Could also unwrap the JSON:API envelope to flatten to `result.items` like curated tools do.

## 4. Link Item Shape — No Structured Attributes

`list_linked_work_items` returns items with composite IDs but no attributes:

```json
{ "id": "elibrary/EL-149/parent/elibrary/EL-147", "type": "linkedworkitems" }
```

Extracting role and target requires string splitting on `/`. Curated work items return
structured `attributes`; links don't.

**Fix:** Curated link tool could parse the composite ID into `{ role, target_project, target_id }`.

## 5. Inconsistent Return Shapes Across Tools

| Tool | Shape |
|------|-------|
| `list_work_items` | `{ items: [{ id, type, attributes }], pagination }` |
| `list_documents` | `{ items: [{ id, type }], pagination }` — no attributes |
| `list_linked_work_items` | `{ items: [{ id, type }], pagination }` — composite ID, no attributes |
| `polarion_api_read` | `{ operation_id, path, data: <raw JSON:API> }` |
| `get_fields_metadata` | Flat object keyed by field name |

No attributes on documents or links makes it harder to filter/map without extra calls.

## 6. Provider Namespace (FIXED)

`@cloudflare/codemode` injected tools under `codemode.*` namespace. Fixed by flattening
tools as bare function arguments in the subprocess worker. Now `list_projects()` instead
of `codemode.list_projects()`.

## 7. Proxy Non-Enumerable (FIXED by flattening)

`codemode` was a Proxy — `Object.keys()` returned `[]`. Couldn't programmatically discover
available tools. With bare functions this is less of an issue, but still can't enumerate
what's in scope since they're function parameters, not object properties.

**Residual:** A `help()` or `tools()` introspection function would still be valuable.

## Priority Summary

| # | Friction | Impact | Effort |
|---|----------|--------|--------|
| 1 | No tool catalog in description | High — causes wrong names, wasted calls | Medium |
| 2 | No param schemas | High — trial-and-error on every new tool | Medium |
| 4 | Link items lack structured attrs | Medium — forces string parsing | Low |
| 5 | Inconsistent return shapes | Medium — can't write generic mapping code | Medium |
| 3 | api_read double nesting | Low — going away with api.* migration | N/A |
