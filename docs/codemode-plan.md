# Codemode MCP Plan

## Goal

Replace both the abandoned `batch_id` direction and the current many-tool MCP surface with a single
codemode-driven MCP.

Target stack:

- `@cloudflare/codemode`
- Deno host + Deno sandbox execution
- one public `code` tool
- concise server instructions and code-tool guidance
- one internal sandbox tool surface containing:
  - curated Polarion workflow tools
  - namespaced raw API tools derived from a trimmed OpenAPI spec

The main product win is eliminating repeated LLM round-trips for loops, conditionals, fan-out,
cross-result joins, and most wide-update orchestration.

## What This Plan Corrects

The first draft was directionally right but too eager to combine four separate changes:

1. product pivot to codemode
2. full runtime migration from Bun to Deno
3. monorepo/package split
4. custom codemode wiring based on an outdated mental model of the library

That is more risk than needed. We should prove the codemode shape first, then decide how much repo
churn is justified.

## Product Position

This is a product pivot away from the old read-biased MCP model.

Implications:

- the replacement product contract lives in
  [docs/product-direction.md](/Users/tomford/code/projects/polarionmcp/docs/product-direction.md)
- writes are allowed in v1
- `jobs` move from blocked to allowed
- admin, license, avatar, icon/binary/download, and similar non-product endpoints stay trimmed out
- codemode replaces the need for `batch_id` orchestration rather than coexisting with it

The server is now a power tool, initially pointed at demo or sandbox data.

## Design Decisions

### 1. Keep the pivot, but stage it

Recommended answer: yes.

We should move toward codemode, but in phases:

- prove the executor and wrapping model on a tiny vertical slice
- prove the OpenAPI escape hatch shape
- only then decide whether the host runtime and repo layout need to change

### 2. Treat batch branch learnings as problem evidence, not code to preserve

Recommended answer: yes.

The batching branch showed the right problem and the wrong abstraction.

Useful lessons from `feat/batch-operations`:

- the real pain is multi-step orchestration, not just "update many IDs"
- query-handle state, fingerprint refresh, and chunked PATCH are compensating for tool-call latency
- write gating mattered because broad writes are dangerous

What should survive:

- awareness that wide workflows need host-side safeguards
- understanding of real bulk PATCH behavior and chunking limits
- the distinction between orchestration problems and transport-throughput problems

What should not survive:

- server-maintained `batch_id` state
- fingerprint caches
- query-handle lifecycle logic

### 3. Move to Deno up front

Recommended answer: yes.

In this repo the Bun-specific seams are small. Moving the host and the sandbox to Deno early
simplifies the runtime story and matches the codemode execution model better.

Expected migration surface:

- `Bun.serve()` in `src/server.ts`
- `Bun.file()` in `src/openapi/read-catalog.ts`
- `bun:test` imports across tests
- package/tooling files

### 4. Monorepo split is optional, not a goal

Recommended answer: no, unless we later have multiple real packages to justify it.

The repo is still small, and if we are shipping one MCP per domain for now, a package split mostly
adds path churn. Keep clear module boundaries inside one package first:

- host/server assembly
- curated Polarion tools
- raw API tool generation/runtime
- executor

### 5. Use `codeMcpServer`, but do not depend on `openApiMcpServer` as the core composition model

Recommended answer: yes.

The first draft assumed custom composition around `createCodeTool` and a bespoke provider model.
Current Cloudflare docs already expose:

- `codeMcpServer({ server, executor })`
- `openApiMcpServer({ spec, executor, request })`

That matters, but the clarified product shape is:

- one public `code` tool
- one internal combined tool surface containing curated tools plus raw `api.*` tools

So `codeMcpServer` remains the key wrapper. `openApiMcpServer` is now reference material rather than
the primary assembly path.

### 6. Make the public surface a single `code` tool, and keep the internal server combined

Recommended answer: yes.

The public MCP should be a single `code` tool. The internal upstream server should contain both
curated tools and raw API tools so they can be chained inside one sandboxed execution.

Recommended v1 shape:

- internal upstream MCP server:
  - curated Polarion tools
  - namespaced raw API tools from the trimmed spec
  - search/help surface over those raw tools
- public MCP server:
  - one `code` tool produced by wrapping the upstream server

This is the right shape because the model can mix high-signal curated tools with raw fallback calls
inside one run.

### 7. Raw API tools should include writes in v1, but only from the trimmed spec

Recommended answer: yes.

The raw API surface is part of the power-tool contract. The boundary is not "read only." The
boundary is "only operations that survive the trim step."

Recommended v1:

- trimmed spec
- curated tools for common workflows
- raw `api.*` tools for trimmed operations, including writes
- no per-request write gate in sandbox/demo deployment

This means the trim policy becomes the primary safety mechanism.

### 8. Keep auth injection and request execution on the host

Recommended answer: yes.

This part of the draft was right. The sandbox must never see bearer tokens. The host request layer
should remain the place that:

- injects auth
- enforces base URL
- applies method/path allowlists
- logs requested operations
- blocks trimmed-out operations

### 9. Drop top-level resources for now; keep guidance in instructions/tool description

Recommended answer: yes.

The guidance we have is short enough to live in the public server instructions and `code` tool
description. That removes one more drift surface while the product is still moving.

Likely to reuse:

- `src/openapi/read-policy.ts`
- `src/openapi/read-catalog.ts`
- concise server instructions, updated for codemode and the power-tool contract

## Recommended Architecture

### Phase 0: viability spike

Goal: prove the critical unknowns with minimal churn.

Build a tiny branch-local spike that answers these questions:

1. Can we implement a Deno-based executor against codemode's current `Executor` interface?
2. Can we build one upstream MCP server containing both curated tools and repo-local raw `api.*`
   tools?
3. Can we wrap that server with `codeMcpServer` and successfully chain curated and raw calls inside
   one execution?
4. Can we front a trimmed Polarion OpenAPI spec with host-side auth injection and no credential
   leakage?

Deliverable:

- small runnable proof
- executor behavior understood
- combined internal server shape proven

Exit criteria:

- one end-to-end `code` call succeeds against curated and raw tools in the same sandbox
- one end-to-end trimmed-spec write succeeds against sandbox data
- timeout/log/error behavior is understood

### Phase 1: vertical slice in the current repo

Goal: build the codemode server in the intended final shape.

Recommended scope:

- move host to Deno
- add Deno sandbox executor
- keep existing curated tool implementations
- flatten the single-package workspace into one repo-root package
- reduce curated tools to the minimal high-signal subset
- build repo-local raw `api.*` tools from the trimmed spec
- expose one public `code` tool by wrapping that upstream server

Initial curated subset:

- `list_projects`
- `list_work_items`
- `get_work_item`
- `update_work_item`
- whichever of `get_fields_metadata`, `get_enum_options`, `get_workflow_actions` remain useful
  enough to beat raw calls

Question to resolve before coding:

Do `list_documents` and `get_document` belong in the initial curated subset? Recommended answer:
only if they are a real day-to-day workflow, otherwise defer.

### Phase 2: raw API tool generation from the trimmed spec

Goal: replace the homegrown generic read/help path with a repo-local raw API namespace.

Recommended scope:

- trim `polarionrest.json` using repo policy logic
- include approved reads and writes
- include `jobs`
- exclude admin/license/avatar/icon/binary/export and similar low-signal surfaces
- generate or register raw `api.*` tools from the surviving operations

Preferred implementation:

- use the trimmed spec plus generated TS types to build repo-local raw tools
- expose a search/help tool over those operations
- expose execution tools that the sandbox can call alongside curated tools

### Phase 3: product hardening

Goal: make codemode the default for wide or multi-step workflows.

Add:

- structured logging around executed operations
- clearer server instructions for when to prefer curated tools vs raw `api.*`
- tests for sandbox timeout, host request policy, and trimmed-spec behavior
- docs showing typical code-mode patterns

## Concrete Implementation Plan

### Step 1. Lock the product contract

Use [docs/product-direction.md](/Users/tomford/code/projects/polarionmcp/docs/product-direction.md)
as the short product contract for the branch and keep it aligned with implementation changes.

### Step 2. Migrate the repo to Deno

Add flake/devshell, Deno config, Deno serve/test equivalents, and update code that currently depends
on Bun APIs.

### Step 3. Implement a minimal executor

Requirements:

- Deno subprocess with no network/filesystem permissions
- timeout enforcement
- captured logs
- clear mapping from sandbox function calls to host callbacks

Important correction:

The current codemode `Executor` interface is:

```ts
interface Executor {
  execute(
    code: string,
    providersOrFns:
      | ResolvedProvider[]
      | Record<string, (...args: unknown[]) => Promise<unknown>>,
  ): Promise<{ result: unknown; error?: string; logs?: string[] }>;
}
```

The important point is that provider-style namespacing is already part of the current interface.

### Step 4. Build the combined internal MCP surface

Start with a tiny upstream MCP server containing:

- curated tools
- raw `api.*` tools
- raw API search/help tool

Success condition:

- codemode can call curated and raw tools in loops and conditionals
- no credentials enter the sandbox
- failures are observable in logs

### Step 5. Reuse policy-driven spec trimming

Build a generator pipeline from:

- `src/openapi/read-policy.ts`
- `src/openapi/read-catalog.ts`
- explicit write allow/block policy
- explicit endpoint-class exclusions

The generator should:

1. load the full upstream spec
2. apply trim policy
3. emit a trimmed spec artifact
4. emit TS types/client from that trimmed spec
5. emit the raw MCP registry from that trimmed spec

This preserves the ability to re-include routes later by changing policy and regenerating, without
needing to fetch and hand-trim again.

The first target is not "all safe operations." The first target is "smallest useful power-tool
slice."

### Step 6. Build raw `api.*` tools from the trimmed spec

Use the spec as the source of truth for:

- operation names
- method/path
- path/query/body parameter metadata
- inclusion/exclusion policy

Use the generated TS client/types as the source of truth for:

- request typing
- response typing

Recommended implementation:

- keep a checked-in trimmed OpenAPI spec
- keep generated TS types/client from that trimmed spec
- add a small repo-local generator script that emits a registry file for raw MCP tools

That registry should contain, per operation:

- tool name such as `api.getJobs`
- operationId
- method
- path template
- input shape metadata for path/query/body
- short description

This is the reusable boundary. We should not hand-maintain the raw tool list.

### Step 6a. Generator choice

Recommended answer:

- use an off-the-shelf generator for TS types/client
- write our own thin registry generator for MCP tool metadata

Why:

- mainstream OpenAPI generators are good at clients and models
- they are not primarily designed to emit "combined codemode-ready MCP tool registry with our
  naming, trim policy, and host-side request semantics"
- our custom layer is small and policy-heavy, which makes it a good place to own the final shape

Current best fit:

- `openapi-typescript` or `@hey-api/openapi-ts` for generated types/client
- repo-local script for trim + MCP registry generation

`@hey-api/openapi-ts` is attractive if we want a more programmable pipeline later because it
explicitly supports plugin-based generation. `openapi-typescript` is attractive if we want to stay
minimal and keep generation close to our current setup.

We do not need a full "OpenAPI to MCP server" generator because the end product is not a standalone
generated MCP server. It is one component inside a combined codemode assembly.

### Step 6b. Cloudflare reference code

Recommended answer:

- reuse ideas and possibly small verbatim helpers from `@cloudflare/codemode`
- do not depend on `openApiMcpServer` as the assembly primitive

The most reusable upstream pieces are small:

- `resolveRefs()` in `packages/codemode/src/mcp.ts`
- response/error formatting patterns in `packages/codemode/src/mcp.ts`
- the shape of `codeMcpServer()` in `packages/codemode/src/mcp.ts`

`openApiMcpServer()` itself is intentionally tiny. It mainly:

- resolves `$ref`s
- exposes `search` backed by `codemode.spec()`
- exposes `execute` backed by `codemode.request()`

That means copying it verbatim is not very helpful for our final product. The better move is to
borrow the relevant helper logic and build our own raw `api.*` layer around the trimmed spec.

### Step 7. Wrap the internal server with `codeMcpServer`

The final public server shape should be:

- one `code` tool
- public instructions/tool description carrying the lightweight guidance

## Explicit Non-Goals For V1

- no resurrection of `batch_id`
- no fingerprint cache
- no dependence on `openApiMcpServer` for the combined sandbox shape
- no hand-maintained raw OpenAPI tool list
- no use of the untrimmed spec at runtime

## Open Questions To Resolve

### 1. Is the desired end state "code tool only" or "direct tools plus code tool"?

Recommended answer: one public `code` tool wrapping an internal combined server.

### 2. Is the raw API namespace read-only or read/write?

Recommended answer: read/write in v1, bounded by trim policy.

### 3. Is Deno a sandbox choice only, or also the host runtime?

Recommended answer: both.

### 4. Do we still want the current metadata/workflow curated tools?

Recommended answer: keep only the ones that materially outperform raw `api.*` calls for common
workflows.

### 5. Are resources and server instructions still part of the product?

Recommended answer: keep instructions; skip separate resources for now.

## Verification

Before calling the plan implementation-ready, prove all of the following:

1. one curated-plus-raw codemode workflow works end-to-end
2. one trimmed-spec write workflow works end-to-end against sandbox data
3. sandbox network access is blocked
4. bearer tokens never appear inside sandbox-visible code or logs
5. timeout and error reporting are intelligible
6. public instructions/tool description carry the needed lightweight guidance
7. test coverage exists for executor behavior and request policy enforcement

## References

- Product contract:
  [docs/product-direction.md](/Users/tomford/code/projects/polarionmcp/docs/product-direction.md)
- Previous batching attempt: `feat/batch-operations`
- Half-baked earlier direction notes:
  [repl_mcp_decisions.md](/Users/tomford/code/projects/polarionmcp/repl_mcp_decisions.md)
