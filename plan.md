# Polarion MCP Implementation Plan

## Context

The Polarion MCP is moving from a working prototype (10 curated tools, `src/server.ts` ~660 lines) to a reliable day-to-day tool. The spec (`spec.md`) defines a 4-layer architecture: curated tools, generic read escape hatch, discovery/help, and resources. This plan delivers all 4 layers in a single PR.

## Design Decisions (confirmed)

- **Read allowlist:** Tier 1 (project-scoped ~75 ops) default, Tier 2 (~15 global ops) behind `scope_mode: "all"`, Tier 3 (~21 binary/admin ops) blocked
- **Help format:** Structured by resource type (workitems, documents, testruns, etc.)
- **Comments v1:** Work item comments only (`add_work_item_comment`)
- **Links v1:** Add + remove single link (`add_work_item_link`, `remove_work_item_link`)
- **Truncation:** Both item count (default 20, max 50) AND char limit (~16KB)
- **Resources v1:** Static only (bundled guides)
- **Instructions:** Moderate expansion (~200 words)
- **Phasing:** Single PR

---

## File Organization

```
src/
  server.ts            -- McpServer creation, instructions, transport, imports registrations
  client.ts            -- Unchanged
  errors.ts            -- Unchanged
  helpers.ts           -- Add truncateResponse(), move authHeaders() here
  allowlist.ts         -- NEW: operation allowlist data + lookup functions
  tools/
    generic-read.ts    -- NEW: polarion_api_read tool
    api-help.ts        -- NEW: polarion_api_help tool
    comments.ts        -- NEW: add_work_item_comment tool
    links.ts           -- NEW: add_work_item_link + remove_work_item_link tools
  resources.ts         -- NEW: static MCP resource registrations
  allowlist.test.ts    -- NEW
  generic-read.test.ts -- NEW
  api-help.test.ts     -- NEW
  tools.test.ts        -- NEW: tests for comment/link tools
  helpers.test.ts      -- Add truncation + authHeaders tests
```

Each tool module exports a `register(server: McpServer)` function. Existing 10 tools stay in `server.ts`.

---

## 1. Operation Allowlist (`src/allowlist.ts`)

Hand-curated `Map<string, AllowlistEntry>` (not generated at build time — need human judgment for tiers, descriptions, curated-tool mappings).

### Data Structure

```typescript
interface AllowlistEntry {
  operationId: string;
  method: "GET";
  pathTemplate: string;          // "/projects/{projectId}/workitems"
  pathParams: string[];          // ["projectId"]
  keyQueryParams: string[];      // ["query", "fields", "sort", "revision"]
  tier: 1 | 2 | 3;
  resourceType: string;          // "workitems", "documents", "testruns", etc.
  description: string;
  curatedTool?: string;          // e.g. "list_work_items"
}
```

### Tier Classification

**Tier 1 (~75 ops):** All project-scoped GETs excluding Content/Icon/Export:
- Work items: `getWorkItems`, `getWorkItem`, `getLinkedWorkItems`, `getLinkedWorkItem`, `getBacklinkedWorkItems`, `getWorkItemApprovals`, `getWorkItemAttachments`, `getWorkItemTestParameterDefinitions`, `getWorkflowActionsForWorkItem`, `getAvailableEnumOptionsForWorkItem`, `getAvailableEnumOptionsForWorkItemType`, `getCurrentEnumOptionsForWorkItem`, `getExternallyLinkedWorkItems`, `getOslcResources`, `getFeatureSelections`, `getComments`, `getComment`, `getWorkRecords`, `getWorkRecord`, etc.
- Documents: `getDocuments`, `getDocument`, `getSpaceDocuments`, `getDocumentAttachments`, `getDocumentComments`, `getDocumentParts`, enum options, etc.
- Test runs: `getTestRuns`, `getTestRun`, `getTestRecords`, `getTestSteps`, `getTestStepResults`, `getTestRunComments`, `getTestRunAttachments`, `getWorkflowActionsForTestRun`, etc.
- Plans: `getPlans`, `getPlan`, `getPlanRelationship`
- Collections: `getCollections`, `getCollection`
- Pages: `getPages`, `getPage`, `getSpacePages`, `getPageComments`, `getPageAttachments`
- Enumerations/metadata: `getProjectEnumerations`, `getProjectFieldsMetadata`, `getProjectCustomFields`
- Single project: `getProject`

**Tier 2 (~15 ops, `scope_mode: "all"`):** `getAllWorkItems`, `getAllDocuments`, `getAllPages`, `getProjects`, `getUsers`, `getUser`, `getCurrentUser`, `getRevisions`, `getGlobalEnumerations`, `getGlobalFieldsMetadata`, `getGlobalCustomFields`, `getMetadata`, `getProjectTemplates`, `getRole`, `getUserGroup`

**Tier 3 (blocked):** All `*Content` endpoints (8), all `*Icon*` (6), `getAvatar`, license endpoints (5), job endpoints (4), `getExportExcelTests`

### Curated Tool Mapping

`getProjects` -> `list_projects`, `getWorkItems` -> `list_work_items`, `getWorkItem` -> `get_work_item`, `getDocuments` -> `list_documents`, `getDocument` -> `get_document`, `getLinkedWorkItems` -> `list_linked_work_items`, `getProjectFieldsMetadata` -> `get_fields_metadata`, `getAvailableEnumOptionsForWorkItemType` -> `get_enum_options`, `getWorkflowActionsForWorkItem` -> `get_workflow_actions`

### Exported Functions

- `getAllowlistEntry(operationId)` — single lookup
- `isAllowed(operationId, scopeMode)` — tier + scope check
- `getAllowlistEntries()` — all entries for help tool
- `getEntriesByResourceType(type)` — filtered for help
- `searchAllowlist(keyword)` — case-insensitive match on operationId + description

---

## 2. `polarion_api_read` Tool (`src/tools/generic-read.ts`)

### Input Schema

```typescript
{
  operation_id: z.string(),
  path_params: z.record(z.string(), z.string()).optional(),
  query: z.record(z.string(), z.unknown()).optional(),
  scope_mode: z.enum(["project", "all"]).optional().default("project"),
  page_size: z.number().min(1).max(50).optional().default(20),
  page_number: z.number().min(1).optional().default(1),
}
```

### Key Implementation Details

1. **Validate** `operation_id` against allowlist. Unknown -> error with similar suggestions. Tier 3 -> blocked error. Tier 2 without `scope_mode: "all"` -> scope error.
2. **Curated tool hint:** If entry has `curatedTool`, include hint but still proceed.
3. **Build URL:** Resolve `pathTemplate` by substituting `{param}` from `path_params`. Validate all required params present.
4. **Raw fetch (not openapi-fetch):** `client.GET()` requires compile-time literal paths. Use raw `fetch()` with `POLARION_BASE_URL` + resolved path. Handle bracket notation for pagination (`page[size]`, `page[number]`) and fields (`fields[workitems]`).
5. **Truncate:** Apply `truncateResponse(data, { maxItems: page_size, maxChars: 16384 })`.
6. **Error handling:** Same pattern as curated tools — `httpError`/`networkError` via `errorResult`.

---

## 3. `polarion_api_help` Tool (`src/tools/api-help.ts`)

### Input Schema

```typescript
{
  keyword: z.string().optional(),       // "test runs", "comments", "approvals"
  resource_type: z.string().optional(), // "workitems", "documents", "testruns"
}
```

### Behavior

- **No external calls** — queries in-memory allowlist only. No `authHeaders` needed.
- **No args:** Return summary — resource types with operation counts.
- **keyword:** Case-insensitive substring match on `operationId`, `description`, `resourceType`, `pathTemplate`. Rank by match count.
- **resource_type:** Filter to matching `resourceType`.
- **Both:** Apply both filters.

### Output Shape

```json
{
  "results": {
    "workitems": [
      {
        "operation_id": "getWorkItems",
        "path": "/projects/{projectId}/workitems",
        "required_path_params": ["projectId"],
        "key_query_params": ["query", "fields", "sort"],
        "scope": "project",
        "risk_class": "curated",
        "curated_tool": "list_work_items",
        "description": "List work items in a project"
      }
    ]
  },
  "total_matches": 15,
  "tip": "Use polarion_api_read with the operation_id to execute. Prefer curated tools when available."
}
```

Risk class mapping: `curatedTool` set -> `"curated"`, tier 1 -> `"generic-read"`, tier 2 -> `"advanced"`, tier 3 -> `"blocked"`. Blocked ops shown but clearly marked.

---

## 4. `add_work_item_comment` Tool (`src/tools/comments.ts`)

### Input Schema

```typescript
{
  project: z.string(),
  work_item_id: z.string(),
  text: z.string(),
  text_type: z.enum(["text/plain", "text/html"]).optional().default("text/plain"),
}
```

### Implementation

Uses typed `client.POST("/projects/{projectId}/workitems/{workItemId}/comments", ...)`. Body follows JSON:API spec:

```typescript
body: {
  data: [{
    type: "workitem_comments",
    attributes: { text: { type: text_type, value: text } },
  }],
}
```

Returns `ok({ created: true, comment_id: data?.data?.[0]?.id })`.

---

## 5. Link Tools (`src/tools/links.ts`)

### `add_work_item_link`

```typescript
// Input
{ project, work_item_id, target_project, target_work_item_id, role, suspect?: boolean }

// Uses typed client.POST("/projects/{projectId}/workitems/{workItemId}/linkedworkitems", ...)
// Body:
body: {
  data: [{
    type: "linkedworkitems",
    attributes: { role, suspect },
    relationships: {
      workItem: { data: { type: "workitems", id: `${target_project}/${target_work_item_id}` } }
    },
  }],
}
```

### `remove_work_item_link`

```typescript
// Input
{ project, work_item_id, role, target_project, target_work_item_id }

// Uses typed client.DELETE("/projects/{projectId}/workitems/{workItemId}/linkedworkitems/{roleId}/{targetProjectId}/{linkedWorkItemId}", ...)
```

---

## 6. Response Truncation (`src/helpers.ts`)

### New: `truncateResponse(rawData, options)`

```typescript
interface TruncationOptions { maxItems: number; maxChars: number; }
```

1. If `rawData` has a `data` array, slice to `maxItems` if over limit.
2. Serialize result. If over `maxChars`, progressively remove items or truncate string.
3. Return `{ data, truncation?: { reason, original_item_count, returned_item_count, hint } }`.

Only used by `polarion_api_read`. Curated tools keep their existing behavior.

### Move: `authHeaders()` from `server.ts` to `helpers.ts`

All tool modules need it. Export from `helpers.ts`.

---

## 7. Static Resources (`src/resources.ts`)

Register two MCP resources via `server.resource()`:

- **`polarion://guides/query-syntax`** — Expanded Lucene query syntax guide (~500 words): field:value, wildcards, booleans, date ranges, custom fields, examples per resource type, sorting
- **`polarion://guides/mcp-usage`** — MCP usage guide (~400 words): tool selection flowchart (curated -> help -> generic read), pagination, field selection, mutation workflows

---

## 8. Server Instructions Update

Expand from ~120 words to ~200 words. Add structured rules before existing query syntax:

```
Polarion MCP Usage Rules:
1. PREFER curated tools over polarion_api_read for common operations.
2. Use polarion_api_help to discover available operations before using polarion_api_read.
3. Always specify fields to minimize response size.
4. Paginate: default page_size is 20, max 50.
5. Use get_fields_metadata to discover custom fields before querying or updating.
6. Check existing links with list_linked_work_items before creating new ones.
7. Generic reads may be truncated. Check the truncation field and paginate if needed.

Resources:
- Read polarion://guides/query-syntax for detailed query syntax.
- Read polarion://guides/mcp-usage for tool selection guidance.

[existing query syntax block]
```

---

## 9. Test Plan

**`src/allowlist.test.ts`:**
- Entry count per tier matches expected
- `getAllowlistEntry` returns correct entries
- `isAllowed` gates tier 2 behind `scope_mode: "all"` and blocks tier 3
- `searchAllowlist` keyword matching works
- `getEntriesByResourceType` grouping
- All entries have valid fields (pathParams match template placeholders)
- `curatedTool` mappings reference valid tool names

**`src/generic-read.test.ts`:**
- Path param substitution (template + params -> resolved path)
- Missing required path param -> error
- Unknown operation_id -> error with suggestions
- Tier 3 -> blocked error
- Tier 2 without `scope_mode: "all"` -> scope error
- `page_size` capped at 50
- Truncation: 100 mock items -> 20 returned with hint
- Char limit truncation with large mock response

**`src/api-help.test.ts`:**
- No args -> resource type summary
- Keyword search returns relevant results
- `resource_type` filter narrows correctly
- Risk class assignment (curated/generic-read/advanced/blocked)

**`src/tools.test.ts`:**
- `add_work_item_comment`: verify request body shape
- `add_work_item_link`: verify relationship data structure
- `remove_work_item_link`: verify path parameters

**`src/helpers.test.ts` (additions):**
- `truncateResponse` no-op when under limits
- `truncateResponse` with item count over limit
- `truncateResponse` with char limit hit
- `authHeaders` extracted and testable

---

## 10. Implementation Order

1. `src/helpers.ts` — add `truncateResponse`, move `authHeaders`
2. `src/allowlist.ts` — full allowlist data + functions (~400 lines) + tests
3. `src/tools/api-help.ts` — `polarion_api_help` + tests
4. `src/tools/generic-read.ts` — `polarion_api_read` + tests
5. `src/tools/comments.ts` — `add_work_item_comment` + tests
6. `src/tools/links.ts` — `add_work_item_link` + `remove_work_item_link` + tests
7. `src/resources.ts` — guide content + registration
8. `src/server.ts` — update instructions, import registrations
9. Verify: `bun test`, `bun run typecheck`

---

## Key Technical Notes

- **Raw fetch for generic read:** `openapi-fetch`'s `client.GET()` requires literal path strings at compile time. `polarion_api_read` uses raw `fetch()` with manual URL construction from `POLARION_BASE_URL`.
- **Allowlist maintenance:** Add comment noting API version. Consider a `package.json` script to diff spec operationIds against allowlist for drift detection.
- **Query param bracket notation:** Generic read must handle `page[size]`, `fields[workitems]` etc. The `query` input supports nested objects that get flattened: `{fields: {workitems: "title"}}` -> `fields[workitems]=title`.
