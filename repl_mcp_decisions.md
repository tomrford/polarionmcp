# REPL MCP Decisions

## Core Product Direction

- Prefer a Python-based MCP over TypeScript for the scripting surface.
- Main reason: give the agent a normal programming model with low mental overhead for loops, filtering, transforms, and batch operations over live data.
- Target use case is wide, programmatic Polarion changes without forcing the model to remember large ID sets across tool calls.

## Deployment / Auth

- Keep auth close to the existing Polarion MCP model:
  - Polarion base URL fixed server-side
  - caller provides a single bearer token
  - token is injected into the SDK/runtime per request
- Prefer a single deployable service/container.

## Execution Model

- No persistent REPL state required.
- One fresh execution context per call is acceptable and preferred.
- The important property is isolation between users/calls, not continuity.
- Immediate/direct writes are acceptable; no mandatory dry-run or plan/apply flow required.
- Polarion’s own audit/versioning is treated as the recovery/audit layer.

## Language / Runtime Constraints

- Python still preferred even after discussing stricter TS-style shells.
- Reason: the real need is a real SDK + real program logic, not a tiny fixed command set.
- Do not center the design on `just-bash`, fake Python, or a shell-first abstraction.
- Treat the runtime as shaped Python rather than a general shell.
- v1 constraint agreed:
  - no user-written `import` statements
  - instead preload the allowed helper surface

## SDK Shape

- For v1, keep it simple: one SDK per deployment/app.
- No need for runtime multi-SDK/plugin selection initially.
- It is acceptable for the app and the SDK to live together if that is simpler.
- OpenAPI-generated client plus a higher-level wrapper/domain SDK remains the preferred structure.

## Security / Boundaries

- The goal is not to make arbitrary Python perfectly safe.
- The goal is to provide a Python-only remote scripting environment shaped around the SDK.
- Stronger restrictions should come from execution boundaries and allowed surface area, not from pretending arbitrary Python can be fully constrained in-process.
- Agreed v1 boundaries:
  - ephemeral per-call execution
  - preloaded SDK
  - limited helper set
  - no shell/package-install affordances

## User / Product Assumptions

- Non-technical users are expected to describe tasks well enough for the LLM to act correctly.
- The MCP should prioritize capability and programmability over heavy workflow guardrails.
- Determinism comes primarily from server-side scripting over freshly queried live data, not from context-window recall.
