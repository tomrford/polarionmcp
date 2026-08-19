# Workerd transition

This file is the research and plan that led to the workerd cutover.
Implemented as a hard cutover onto pnpm/Node, workerd in Docker, and
Cloudflare's `/mcp?codemode=false` factory. Date: 19 August 2026.

## The plan

Move polarionmcp’s HTTP MCP onto **workerd in Docker**. Copy Cloudflare’s **query-param composition** and **Dynamic Worker hosting**. Keep Polarion’s **curated tool shapes**.

Cloudflare’s official API MCP (`cloudflare/mcp`, `https://mcp.cloudflare.com/mcp`) can expose raw OpenAPI as ~2,500 native tools when Code Mode is off. Polarion cannot. This repo’s generated tools auto-paginate collections, return stable envelopes, and honour the allowlist. Those stay on the host whether Code Mode is on or off. `?codemode=false` switches the **public tool list** on one `/mcp` URL. It does not switch Polarion over to raw OpenAPI.

### Copy from Cloudflare

From production [`cloudflare/mcp`](https://github.com/cloudflare/mcp), not from `@cloudflare/codemode`:

- One Worker process, one `/mcp` path, Streamable HTTP, stateless `createMcpHandler`-style factory.
- `?codemode=false` (exact string `false`) opts out of Code Mode so an outer harness that already sandboxes tools does not nest another isolate. Default stays Code Mode.
- Dynamic Workers for agent JavaScript: `worker_loaders` binding, `LOADER.load()` / `LOADER.get()`, throw the isolate away.
- Auth never enters the child isolate. Cloudflare injects the token in a parent `GlobalOutbound` `WorkerEntrypoint`. Polarion already keeps the Bearer on the host (`AsyncLocalStorage` / `authHeaders()`). Same rule on workerd: host fetch or RPC dispatcher holds the token.
- Health on `/healthz` and `/readyz`. Compose still runs one container.

From `@cloudflare/codemode` only if it stays cheaper than a thin local executor: `DynamicWorkerExecutor` plus the `Executor` interface. Do not expect that package to provide `?codemode=false`, Polarion `search`, or `read_attachment`. Those are app code, as in `cloudflare/mcp`.

### Keep from polarionmcp

- Allowlist and codegen (`docs/allowlist.md`, `scripts/generate.ts` → pnpm).
- Curated generated tools: pagination, `FETCH_CONCURRENCY_COUNT`, collection/resource/`{ ok: true }` envelopes.
- Fuzzy `search` catalog over `codemode.<operationId>`, not “run JS against the OpenAPI document”.
- Public default surface: `search`, `code`, `read_attachment`.
- `read_attachment` as a host tool on **both** public lists (Code Mode on and off).
- Host-side `Authorization: Bearer` and `POLARION_BASE_URL`.

Draft PR #4 already has the query-param split on Deno. Reimplement that factory on workerd; do not invent a second route.

### Drop

- Deno as runtime: `Deno.serve`, `Deno.Command`, stdio MCP, `deno task start`, flake Deno-as-runtime.
- `DenoSubprocessExecutor` / `subprocess-worker.ts`.
- `CUSTOM_INSTRUCTIONS.md` / `read_guidelines` filesystem reads.
- Host `cwebp`. Use `@jsquash/jpeg` + `@jsquash/png` + `@jsquash/webp` in the parent Worker.

Codegen moves to node/pnpm (`node:fs` + `pnpm exec openapi-typescript`). Tests move to `@cloudflare/vitest-pool-workers`. Production process is `workerd serve`, not long-term `wrangler dev`.

### Topology

One workerd process in the existing Compose-style container.

```
POST /mcp                  → Code Mode tools (search, code, read_attachment)
POST /mcp?codemode=false   → curated Polarion operationId tools + read_attachment
GET  /healthz|/readyz      → { ok: true }
```

Inside the parent isolate:

1. Read `codemode` from the request URL. Build **one** `McpServer` for that request, same as [`cloudflare/mcp` `src/mcp-handler.ts`](https://github.com/cloudflare/mcp/blob/main/src/mcp-handler.ts).
2. Polarion curated tools live in-process (today’s `createServer()` + `InMemoryTransport` pair, or the same functions without an MCP wrapper). Not a second Worker.
3. On `code()`, `LOADER.load()` a Dynamic Worker with RPC tool stubs and `globalOutbound: null` (or a Polarion-only outbound, if you later want sandbox `fetch` to Polarion through a host proxy). Discard the isolate.
4. `read_attachment` fetches Polarion and transcodes with jSquash in the parent.

`codemode.getProjects(...)` is RPC back into the parent, which runs the curated tool (including pagination). The child never sees the token and never talks to Polarion directly unless you add a locked outbound later.

### Not in the plan

- Raw OpenAPI as the non-Code-Mode surface. Cloudflare can; Polarion’s pagination and envelopes are the product.
- Two HTTP routes (`/mcp` vs `/codemode`). That is the agents SDK demo. Production Cloudflare API MCP uses the query param.
- A container or `docker run` per `code()` eval.
- `@imagemagick/magick-wasm` (≈14 MiB; workerd blocks `eval` / `WebAssembly.compile`).
- Cloudflare account, Paid plan, or `wrangler deploy` to CF. Local FOSS workerd is enough. Worker Loader was verified here with wrangler 4.124.0 / workerd 1.20260815.1 and no login.

### Implementation order

1. Scaffold the parent Worker: wrangler config, `workerd serve` in Compose, `POST /mcp`, `GET /healthz`, `GET /readyz`.
2. Port Polarion curated tools and host Bearer fetch onto that parent (no Deno).
3. Add the query-param factory: default `search` / `code` / `read_attachment`; `?codemode=false` registers curated `operationId` tools plus `read_attachment`.
4. Implement `code()` with `LOADER.load()`, RPC stubs into the parent curated tools, and `globalOutbound: null`. Discard the isolate.
5. Transcode attachments with jSquash in the parent.
6. Move codegen to pnpm and tests to `@cloudflare/vitest-pool-workers`.
7. Remove Deno, stdio, `cwebp`, and `CUSTOM_INSTRUCTIONS.md`.

## Background

The sections below are the research that led to this plan: FOSS Worker Loader, package vs official MCP, attachments, and discarded Deno blockers.

### What main is today

Public tools: `search`, `code`, `read_attachment`, optional `read_guidelines`. Internally two MCP servers linked by `InMemoryTransport` (`src/codemode/polarion-code-mcp-server.ts`, adapted from `@cloudflare/codemode` 0.3.3). `code` is `DenoSubprocessExecutor`, a Deno child, not a V8 isolate. `read_attachment` shells out to `cwebp`. HTTP is stateless Streamable HTTP. No wrangler/workerd config on main.

### FOSS Dynamic Workers

Open-source workerd implements Worker Loader (`get` / `load`) under Apache 2.0. Wrangler `worker_loaders` is first-class from 4.39.0. `load()` landed in [workerd#6316](https://github.com/cloudflare/workerd/pull/6316) (March 2026).

Verified here with no Cloudflare login: wrangler 4.124.0 / workerd 1.20260815.1, `wrangler whoami` unauthenticated, `env.LOADER.load({ globalOutbound: null })` returned `dynamic-ok` from `wrangler dev`. Linux-64 workerd binary is 144 MiB.

CF-cloud-only: Paid-plan open beta, per-isolate billing, hosted KV/R2/D1. Not required for Compose self-host.

### `@cloudflare/codemode` vs `cloudflare/mcp`

`DynamicWorkerExecutor` is the Workers isolate executor. `codeMcpServer()` wraps an existing MCP with a single `code` tool via in-process `InMemoryTransport`. `openApiMcpServer()` is search-and-execute against a spec — Cloudflare’s own catalog shape, not Polarion’s fuzzy `operationId` catalog.

`?codemode=false` is **not** in that package. Official API MCP implements it in [`src/mcp-handler.ts`](https://github.com/cloudflare/mcp/blob/main/src/mcp-handler.ts):

```ts
const codemode = new URL(requestInfo.url).searchParams.get('codemode') !== 'false'
return createServer(props, codemode)
```

Their `package.json` has no `@cloudflare/codemode`. Non-code-mode is lazy `tools/list` / `tools/call` over a precomputed JSON artifact because raw OpenAPI is thousands of tools. Polarion has ~198 curated tools, so ordinary `registerTool` is fine. Their `execute` is hand-written `LOADER.get` plus `GlobalOutbound` token injection.

MCP portals use a different query dialect (`?codemode=off` / `?codemode=search_and_execute`). Copy the public API MCP: `false` exact.

### Attachments

Run jSquash in the parent on `read_attachment`. Do not put Polarion bytes or the encoder in the Dynamic Worker. Existing 4–8 MiB caps stay.

### Earlier A/B/C

First pass recommended wait **(C)** because Deno/stdio/`cwebp`/codegen looked expensive. Those are discarded. Worker Loader is usable FOSS. The plan above is **(B)**: MCP-on-workerd in Docker, with Polarion’s curated tools and Cloudflare’s query-param plus Dynamic Worker hosting.
