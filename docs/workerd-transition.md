# Workerd transition research

Research only. No implementation. Date: 19 August 2026.
Repo verified on `main` at `986a6fc`.

**Recommendation: (C) wait / hybrid.** Worker Loader is usable FOSS on local workerd. Moving polarionmcp’s whole MCP host onto workerd-in-Docker would improve the `code()` sandbox and would not simplify today’s architecture. Stay on Deno HTTP until a dedicated spike proves MCP, Polarion auth, and attachments in one workerd process.

## What main is today

Verified in this repo, not taken from the brief.

The public MCP server is one process with a small tool list: `search`, `code`, `read_attachment`, and optional `read_guidelines` when `CUSTOM_INSTRUCTIONS.md` is present. See `src/codemode/polarion-code-mcp-server.ts` and `README.md`.

Internally there are two MCP servers. `createServer()` in `src/register.ts` registers the allowlisted Polarion `operationId` tools. `createPolarionCodeMcpServer()` wraps that server with `InMemoryTransport` and exposes the public tools. The file header says it is adapted from `@cloudflare/codemode` 0.3.3 `dist/mcp.js`. `package.json` pins that version.

`code` does not run in a V8 isolate. `DenoSubprocessExecutor` in `src/codemode/deno-executor.ts` spawns `Deno.Command(Deno.execPath(), ["run", "--quiet", workerUrl.pathname])` and talks JSON lines to `src/codemode/subprocess-worker.ts`. The child uses `new Function(...)` to run the agent script, then exits.

`read_attachment` in `src/attachments.ts` is a public tool on the host server, not a sandbox capability. PNG and JPEG bytes go through host `cwebp` (`Deno.Command("cwebp", ...)`). `Dockerfile` installs Debian `webp`. `flake.nix` provides `libwebp`. Isolates cannot exec that binary.

Auth is host-side. HTTP `POST /mcp` reads `Authorization: Bearer` in `src/server.ts` and stores the token in `AsyncLocalStorage` (`src/request-context.ts`). Generated Polarion fetches read it via `authHeaders()`. The sandbox never receives the token. stdio mode reads `POLARION_ACCESS_TOKEN` from the environment. Tom is happy to drop stdio.

There is no `wrangler.toml` or workerd config on main. Cloudflare appears as `@cloudflare/codemode` plus README links.

HTTP is stateless Streamable HTTP with `WebStandardStreamableHTTPServerTransport` and `enableJsonResponse: true`. Unauthenticated `GET /healthz` and `GET /readyz` sit beside `/mcp`. Deploy is `compose.yaml` around the Deno image.

Draft PR #4 (`?codemode=false`) muxes two public MCP surfaces on one endpoint. That is the wrong product shape and is ignored as a target.

## 1. FOSS Dynamic Workers

**Yes. Open-source workerd implements Worker Loader. Local wrangler/workerd can load Dynamic Workers with no Cloudflare account.**

Evidence in Cloudflare’s own source:

- workerd C++ API: [`src/workerd/api/worker-loader.h`](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/worker-loader.h) exposes `get(id, getCode)` and `load(code)`. `load()` is a shortcut for one-off workers (`get(null, () => code)`). Kenton Varda added `load()` in [workerd#6316](https://github.com/cloudflare/workerd/pull/6316) (merged 14 March 2026).
- workerd config schema: [`src/workerd/server/workerd.capnp`](https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp) defines a `workerLoader` binding. Comment: “the ability to dynamically load Workers from code presented at runtime.”
- License: workerd is [Apache 2.0](https://github.com/cloudflare/workerd/blob/main/LICENSE). Prebuilt binaries ship as npm `workerd` / `@cloudflare/workerd-linux-64`.
- Wrangler config: `worker_loaders = [{ binding = "LOADER" }]`. First-class config landed in [wrangler 4.39.0](https://github.com/cloudflare/workers-sdk/releases/tag/wrangler@4.39.0) ([workers-sdk#10721](https://github.com/cloudflare/workers-sdk/pull/10721), September 2025). Earlier builds used `unsafe.bindings` of type `worker-loader`.
- Miniflare maps that config onto workerd: [`packages/miniflare/src/plugins/worker-loader/index.ts`](https://github.com/cloudflare/workers-sdk/blob/main/packages/miniflare/src/plugins/worker-loader/index.ts) emits `{ name, workerLoader: {} }`.
- Official local fixture: [`fixtures/dynamic-worker-loading`](https://github.com/cloudflare/workers-sdk/tree/main/fixtures/dynamic-worker-loading) in workers-sdk. Parent Worker calls `env.LOADER.get(url.pathname, () => ({ compatibilityDate, mainModule, modules }))` and forwards `fetch()`.
- Docs: [Dynamic Worker Loaders](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/) say the API is available in local development with Wrangler and workerd. [Getting started](https://developers.cloudflare.com/dynamic-workers/getting-started/) shows `env.LOADER.load({ compatibilityDate, mainModule, modules, globalOutbound: null })`. [Code Mode blog](https://blog.cloudflare.com/code-mode/) says Dynamic Worker Loading is fully available when developing locally with Wrangler and workerd.

Verified in this environment on 19 August 2026, with no Cloudflare login:

1. Installed `wrangler@4.124.0`, which pulled `workerd@1.20260815.1` (linux-64 binary **144 MiB**).
2. `npx wrangler whoami` printed “You are not authenticated.”
3. A one-file Worker with `worker_loaders: [{ binding: "LOADER" }]` called `env.LOADER.load({ ..., globalOutbound: null })`.
4. `npx wrangler dev --ip 127.0.0.1 --port 8787` became ready without prompting for an account.
5. `GET /` returned `dynamic-ok` from the child isolate (16 ms, then 4 ms on a second request).

Recommended local versions if this is ever implemented: **wrangler ≥ 4.39.0** for `worker_loaders` config; **workerd ≥ 1.20260314** (the `load()` PR) for one-off `LOADER.load()`. Current wrangler 4.124 / workerd 1.20260815.1 satisfies both. `@cloudflare/codemode`’s `DynamicWorkerExecutor` uses `load()`, not `get()`.

What is still Cloudflare-cloud-only:

- Deploying Dynamic Workers onto Cloudflare’s network. Older loader docs still say [closed beta](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/). Newer docs and the [24 March 2026 changelog](https://developers.cloudflare.com/changelog/post/2026-03-24-dynamic-workers-open-beta/) say **open beta on the Workers Paid plan**. Tom’s target is Compose, so this does not block self-host.
- [Dynamic Workers pricing](https://developers.cloudflare.com/dynamic-workers/pricing/): Paid plan only. Unique Dynamic Workers created per day ($0.002 each after the included 1,000/month; billed from 26 May 2026), plus standard Workers request and CPU rates. Local workerd has no such meter.
- Production Cloudflare products that are not in the workerd binary as first-class self-host: account dashboard, billing, Workers for Platforms dispatch namespaces, hosted KV/R2/D1, production Durable Object storage, and CF-only observability APIs.
- Experimental compatibility flags that the parent must itself enable with `"experimental"`; those flags cannot be enabled in CF production. Local workerd can allow them.

Self-host production shape is `workerd serve <config.capnp>`, which workerd’s README calls an application server. `wrangler dev` is the local/dev path (what we ran). Putting `wrangler dev` in Compose as “production” would work for a spike and is the wrong long-term process model (file watching, inspector UI, unstable flags).

## 2. `@cloudflare/codemode` on workerd vs Deno

On Cloudflare, `code()` uses `DynamicWorkerExecutor`. On this repo, it uses `DenoSubprocessExecutor`.

`DynamicWorkerExecutor` lives in [`cloudflare/agents` `packages/codemode/src/executor.ts`](https://github.com/cloudflare/agents/blob/main/packages/codemode/src/executor.ts) (package now **0.5.1**, MIT). It requires a `WorkerLoader` binding. For each `execute()` it:

1. Normalises the agent script with acorn (same idea as `src/codemode/deno-executor.ts`).
2. Builds a child Worker module that extends `WorkerEntrypoint` and evaluates the script inside `Promise.race` with a timeout (default 60 s).
3. Calls `loader.load({ compatibilityDate: "2025-06-01", compatibilityFlags: ["nodejs_compat"], mainModule: "executor.js", modules, globalOutbound, env })`.
4. Passes `ToolDispatcher` RPC stubs (`cloudflare:workers` `RpcTarget`) into `evaluate()`, so `codemode.getProjects(...)` is RPC back to the parent, not a network call from the child.
5. Defaults `globalOutbound` to `null`, so child `fetch()` / `connect()` throw.
6. Disposes the child Worker after the result.

This repo’s executor is the same `Executor` interface (`execute(code, ResolvedProvider[])`) implemented with a Deno child and JSON-line RPC. Isolation is process-level, not isolate-level. The child is a full Deno runtime: it can use Deno APIs unless the spawn flags deny them. Current spawn is `deno run --quiet` with no permission lockdown.

Stock MCP wrappers in `@cloudflare/codemode/mcp`:

- `codeMcpServer({ server, executor })` still creates **two MCP servers** linked by `InMemoryTransport`, discovers upstream tools, and exposes a single `code` tool. That is the same dual-server shape polarionmcp forked. It does **not** add Polarion’s fuzzy `search`, `read_attachment`, `read_guidelines`, or host token wrapping. Official example: [`examples/codemode-mcp`](https://github.com/cloudflare/agents/tree/main/examples/codemode-mcp).
- `openApiMcpServer({ spec, executor, request })` exposes `search` + `execute`, but `search` is **code against the OpenAPI document**, not a fuzzy catalog of generated `operationId`s. `execute` calls a host `request()` so auth stays out of the sandbox. That is Cloudflare’s own MCP shape, not polarionmcp’s.

**polarionmcp cannot drop `polarion-code-mcp-server.ts` and use the stock package unchanged.** It can reuse `DynamicWorkerExecutor` *if the host runs on workerd*, and keep Polarion’s public tools and catalog. The generated Polarion MCP tools (pagination, envelopes, allowlist) still have to live on the host, either as the current internal MCP server or as a thinner host `request()` / RPC binding.

`@cloudflare/codemode` 0.3.3 is already a type-only dependency here (`import type { Executor }`). Current 0.5.1 is runtime-agnostic about the `Executor` interface and still ships a Workers-only executor.

## 3. MCP on workerd in Docker

Concrete shape that matches Tom’s constraints (one public MCP server, HTTP `/mcp` only, no container per eval, Compose-class deploy):

1. One container runs one workerd process (or wrangler-launched workerd).
2. The parent Worker handles `POST /mcp`, `GET /healthz`, `GET /readyz`.
3. Bearer auth is applied in the parent `fetch` handler, as `src/server.ts` does today.
4. `code()` calls `env.LOADER.load(...)` with Polarion tool bindings (RPC `ToolDispatcher` or a Polarion `WorkerEntrypoint`) and `globalOutbound: null`.
5. The child isolate is discarded after the result.

Compared with today’s `Deno.serve` HTTP server, the public protocol can stay the same. This repo already uses `WebStandardStreamableHTTPServerTransport`, which the MCP TypeScript SDK documents for Cloudflare Workers, Deno, Bun, and Node 18+. Cloudflare’s Agents docs recommend `createMcpHandler` for Workers Streamable HTTP.

APIs that would break or move:

| Current API | Where | On workerd |
| --- | --- | --- |
| `Deno.Command` / `Deno.execPath()` | `deno-executor.ts` | Gone. Replaced by Worker Loader. |
| `Deno.Command("cwebp")` | `attachments.ts` | Gone. Isolates and the parent Worker cannot exec binaries. |
| `Deno.serve` | `server.ts` | Worker `fetch`. |
| `Deno.env` | `client.ts`, generated tools, attachments, tests | `env` bindings / `process.env` with `nodejs_compat`. |
| `Deno.args` / stdio transport | `server.ts` | Drop. Tom accepts HTTP only. |
| `Deno.readTextFile("CUSTOM_INSTRUCTIONS.md")` | `custom-instructions.ts` | Bundle at build, or a text module / volume read that workerd actually allows. |
| `node:async_hooks` `AsyncLocalStorage` | `request-context.ts` | Works under `nodejs_compat` (already used on Workers). |
| `deno test` / `deno task start` | `deno.json` | Replace with vitest-pool-workers and `workerd serve` / wrangler. |
| `scripts/generate.ts` `Deno.Command` | codegen | Can stay Deno. Runtime and generator do not have to share a runtime. |
| `flake.nix` `deno` + `libwebp` | dev shell | Would add wrangler/workerd; `libwebp` only if cwebp stays. |

workerd cannot spawn processes. A “host binding” for `cwebp` is not a Worker Loader feature. It would be a second process in the container, or a WASM encoder inside the parent Worker.

## 4. What goes away vs what stays

Goes away if the HTTP host moves to workerd:

- `DenoSubprocessExecutor` and `subprocess-worker.ts`
- stdio MCP (`StdioServerTransport`, `POLARION_ACCESS_TOKEN`, `deno task start:stdio`)
- `deno task start` as the Compose command; `Dockerfile` `FROM denoland/deno:2.7.14`
- flake Deno-as-runtime (Deno can remain the generator toolchain)
- The weaker sandbox (full Deno child with no permission flags)

Does **not** go away automatically:

- Dual in-process MCP (`InMemoryTransport` + generated Polarion tools). Stock `codeMcpServer()` keeps this. Removing it means rewriting Polarion calls as RPC bindings or as `openApiMcpServer`’s host `request()`.
- OpenAPI allowlist and codegen (`scripts/generate.ts`, `docs/allowlist.md`, 198 allowed / 86 blocked operations)
- Pagination, concurrency, and response envelopes in `src/generated/register-generated-tools.ts`
- Host-side Bearer auth and `POLARION_BASE_URL`
- `read_attachment` URL allowlisting (`src/attachment-routes.ts`)
- Health endpoints and Compose probes
- Fuzzy `search` catalog (Polarion-specific; not stock `codeMcpServer`)
- Attachment transcode policy, unless the product drops it

The hypothesis is right that workerd replaces the Deno child. It is wrong if it is read as “Worker Loader removes the internal MCP pair.”

## 5. Attachments

Isolates cannot run `cwebp`. If the MCP host is also workerd, the parent cannot run it either.

Options:

1. **WASM encoder in the parent Worker** (`@jsquash/webp` / libwebp-wasm). Same lossless-WebP behaviour, no extra process. Adds wasm size and CPU on the request path. Best fit if the host moves to workerd and inline images still matter.
2. **Drop transcode.** Return JPEG/PNG/GIF/WebP as today without conversion. Simplest. The inline budget and metadata-only fallback already exist. Loses the size win that PR #1 added.
3. **Sidecar helper** in the same Compose service (tiny process that speaks HTTP to the Worker and runs `cwebp`). Preserves native encoder. Adds a second runtime in the container Tom wants to keep simple.

`read_attachment` should stay a **public host tool**, not a sandbox binding. That is already the design: `code` returns attachment metadata; the agent calls `read_attachment` separately. Do not put Polarion bytes or `cwebp` inside the Dynamic Worker.

**Recommend (2) if moving to workerd soon; (1) if the lossless-WebP budget is still a product requirement.** Do not add a sidecar unless measurement shows WASM is too slow or too large.

## 6. Would this actually simplify?

**Only the sandbox. Stay on Deno for the product as it exists.**

The public surface is already the shape Tom wants: one MCP server, `search` + `code` + `read_attachment`, flexibility inside `code()`, throw the eval away. The Deno child is an ugly isolate substitute, not a second public server.

workerd would give a real isolate, network-off by default, and RPC Polarion bindings. That is a better sandbox, not a smaller system.

The biggest remaining hodgepodge after a move would still be Polarion itself: allowlisted OpenAPI codegen, generated-tool pagination/envelopes, host token plumbing, and attachment policy. Dual MCP stays unless that is rewritten too. On top of that you would add a second toolchain (wrangler/workerd plus Deno-for-generate), a WASM or dropped transcode path, and a Compose story around `workerd serve` instead of `deno task start`.

Draft PR #4 would make the public surface worse, not better.

## 7. Blockers and unknowns

- **License.** workerd Apache 2.0; wrangler MIT; `@cloudflare/codemode` MIT; this repo MIT. No license block for self-host.
- **Worker Loader locally.** Not missing. Verified with wrangler 4.124.0 / workerd 1.20260815.1 and no Cloudflare account.
- **MCP SDK on Workers.** Streamable HTTP transport already in use is web-standard. Official `@cloudflare/codemode` still produces an MCP SDK v1 server and the agents example uses `createLegacyMcpHandler`. Polarion is on `@modelcontextprotocol/sdk` 1.25.3. A move should pin an SDK version that is known to run under workerd `nodejs_compat` (zod 4, in-memory transport, no Node `http.Server`).
- **Image size.** workerd linux-64 binary is **144 MiB** uncompressed (npm `1.20260815.1`). Deno 2.7.14 official Ubuntu image is about **78 MiB** compressed, deno binary layer about **49 MiB**. workerd is not smaller. A wrangler+node_modules image is larger still. `workerd serve` without wrangler is the slimmer self-host option and still larger than today’s Deno binary.
- **Test story.** Current gate is `deno task fmt:check`, `lint`, `test`, `check`. workerd’s official path is `@cloudflare/vitest-pool-workers`. Generator tests can stay on Deno. Runtime tests that spawn `DenoSubprocessExecutor` would have to become workerd pool tests. Dual toolchain until generate is rewritten.
- **Production process.** `wrangler dev` is not a Compose production server. `workerd serve` needs a generated capnp config. That packaging is undocumented relative to Deno’s `CMD ["deno", "task", "start"]`.
- **Filesystem.** workerd has no general `Deno.readTextFile`. Custom instructions, allowlist docs, and tests that mutate `Deno.env` need another source.
- **Memory / isolate cache.** `load()` is one-shot and avoids cache churn (`DynamicWorkerExecutor` comment). Unknown how a 198-tool generated catalog plus MCP SDK sits in one parent isolate under load.
- **Docs drift.** Closed-beta vs open-beta language is inconsistent across CF pages. For self-host this only matters if someone later wants CF-cloud deploy.

## 8. If Worker Loader were not usable FOSS

It is usable FOSS. If it were not, the closest FOSS isolate options would be:

- **`isolated-vm`** (Node native addon, separate V8 isolate, memory/CPU limits). Closest isolation model. Native addon; not Deno; maintenance-mode risk; worse than workerd’s binding/RPC story.
- **Deno Workers** with `permissions: "none"`. Same runtime you already have. Weaker than workerd `globalOutbound: null` + RPC bindings. Better than today’s un-permissioned `deno run` child.
- **quickjs-emscripten**. Strong WASM boundary, slower, no Workers RPC.

None of those are worth a rewrite if Worker Loader is available, and it is. Do not fake isolates with `docker run` per eval. Do not mux two public MCP servers on one HTTP endpoint.

## Path

**(C) wait / hybrid.**

Keep Deno HTTP `/mcp` as the production runtime. Drop stdio when convenient. Ignore PR #4 as a target.

Treat workerd as a future runtime experiment, not a simplification of Polarion, auth, codegen, or attachments. The FOSS gate is already open: Worker Loader runs locally with wrangler/workerd and no Cloudflare account.

A later spike would need to prove, in one container, all of: Streamable HTTP `/mcp`, host Bearer auth that never enters the child, `DynamicWorkerExecutor` or equivalent `LOADER.load()`, Polarion host fetch with the current allowlist behaviour, `search` + `code` + `read_attachment` as **one** public server, and an attachment policy that does not exec `cwebp` from an isolate. Until that spike is green, a move would replace a working Deno child with a larger operational surface.

**(A)** is also honest if the isolate quality of the current Deno child is acceptable. **(B)** is technically possible and is not a simplification of today’s architecture.

## Follow-up (19 August 2026): discarded Deno surface, two-Worker model, WASM WebP

Tom’s later constraints: drop stdio; do not keep Deno APIs; node/pnpm can own codegen; deprecate `CUSTOM_INSTRUCTIONS.md` filesystem reads; V8 isolate is the point; WebP exists only to shrink images for Claude; WASM encoder is acceptable.

Those Deno items in section 3 were an inventory of what changes, not reasons to stay. With them discarded, they are not blockers.

### Codegen on node/pnpm

`scripts/generate.ts` is ordinary TypeScript plus `Deno.readTextFile` / `writeTextFile` / `mkdir` and one `Deno.Command` that runs `npm:openapi-typescript@7.10.1`. That ports to `node:fs` and `pnpm exec openapi-typescript` with no product change. The allowlist and generated operations stay.

### Two Workers vs stock `@cloudflare/codemode`

`codeMcpServer({ server, executor })` binds an existing MCP server. It does **not** put that tools MCP in its own Worker.

Stock topology, including [`examples/codemode-mcp`](https://github.com/cloudflare/agents/tree/main/examples/codemode-mcp):

1. **One long-lived parent Worker** owns HTTP `/mcp` (or `/codemode`). Inside that isolate sit both MCP servers, linked by `InMemoryTransport` — the same pair polarionmcp already has. Polarion `operationId` tools stay here, with host Bearer auth.
2. **One Dynamic Worker per `code()` call.** `DynamicWorkerExecutor` does `LOADER.load()`, injects RPC `ToolDispatcher` stubs, sets `globalOutbound: null`, runs the script, discards the isolate.

Sandbox `codemode.getProjects(...)` is RPC back into the parent, which then calls the in-process tools MCP. There is no second long-lived tools Worker.

You *can* move Polarion tools into a static service-binding Worker. That is an extra split, not what the package does, and it does not buy a better sandbox.

`codemode=false` as “go straight to the tools” also does not need a second Worker. Serve the existing Polarion `McpServer` without wrapping it. The official example does that as a **second HTTP path** (`/mcp` raw tools, `/codemode` wrapped). That is two public MCP servers. Draft PR #4 did the same split on one `/mcp` with `?codemode=false`. Both are feasible. Both are the public-surface shape previously rejected. The V8 sandbox does not require that opt-out.

Default product on workerd: one public server (`search`, `code`, `read_attachment`); tools MCP stays private inside the parent; each `code()` gets a throwaway isolate.

### WASM WebP

`@imagemagick/magick-wasm` is a poor fit on workerd. The wasm is about **13.9 MiB**. Cloudflare Workers / workerd disallow `eval` and `WebAssembly.compile()` of raw bytes ([magick-wasm#195](https://github.com/dlemstra/magick-wasm/discussions/195)). People who hit that switched to jSquash.

Prefer **`@jsquash/jpeg` + `@jsquash/png` + `@jsquash/webp`**. jSquash is built for no-eval runtimes, uses libwebp, documents a Workers import of the `.wasm` as a `CompiledWasm` module, and is about **1 MiB** per codec rather than a full ImageMagick. That matches the current job: decode JPEG/PNG, encode lossless-ish WebP, stay under the existing 4–8 MiB attachment caps. Run it in the **parent** Worker on `read_attachment`, not inside the Dynamic Worker.

### Feasible?

**Yes.** With the Deno surface dropped, CUSTOM_INSTRUCTIONS deprecated, codegen on pnpm, and jSquash in the parent, MCP-on-workerd in Docker is a runtime swap plus attachment codec, not a Polarion redesign.

What remains to build: wrangler/`workerd serve` Compose process; parent Worker `fetch` + host Bearer; keep or lightly adapt the Polarion tools MCP + `search`/`code`/`read_attachment`; `DynamicWorkerExecutor` + `worker_loaders`; jSquash WebP; vitest-pool-workers. Auth, allowlist, pagination envelopes stay.

That is path **(B)** if the isolate is the goal. Path **(C)** only if you still want a spike before touching Compose. The earlier “Deno APIs would break” list is not a reason to wait.
