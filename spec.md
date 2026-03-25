# Polarion MCP High-Level Spec

## Purpose

This document defines the intended shape of the Polarion MCP as it moves from a useful prototype to a reliable day-to-day tool for internal engineering work.

The goal is not to expose the entire Polarion REST API one-to-one. The goal is to give models and users a small, safe, high-signal interface for the tasks they are good at, while preserving an escape hatch for less common read-only needs.

## Product Principles

### 1. Optimize for model reliability, not API completeness

Models are better at:

- deep tasks: several sequential calls with small, local context
- narrowing down from discovery to detail
- guided edits when the write target is explicit and scoped

Models are worse at:

- wide tasks: attempting to reason over very large result sets in one step
- exhaustive workflows that require guaranteed coverage
- broad mutation surfaces where one mistaken call can affect many objects

The MCP should be designed around those strengths and weaknesses.

### 2. Favor small, curated tools for common workflows

The default MCP surface should remain small and oriented around real day-to-day tasks:

- find projects
- find work items
- inspect a work item
- inspect documents
- discover fields and enums
- inspect workflow actions
- perform narrow, explicit updates for known safe workflows
- manage a small number of tightly scoped mutations such as comments or links when justified by real use

These tools should encode intent directly in the tool name and input schema.

### 3. Provide a generic read escape hatch, not a generic write surface

A generic read tool is acceptable because:

- read operations are lower risk
- read workflows can be iterative
- models can call it repeatedly to drill down
- it avoids adding dozens or hundreds of low-value one-off tools
- a single project-scoped read surface covers a large share of the OpenAPI's repeated patterns

A generic write tool is explicitly out of scope for the intended mature product because:

- models cannot be trusted to be exhaustive on wide update tasks
- the Polarion API includes bulk and action-style operations with high blast radius
- a generic write surface is harder to validate, explain, audit, and constrain

### 4. Keep guidance out of tool bloat

Large per-tool descriptions are not the right place to teach the API.

Instead, guidance should live in:

- concise MCP server instructions for global usage rules
- MCP resources for docs and project-specific guidance
- small discovery/help responses generated on demand

### 5. Tailor for internal use cases first

This MCP does not need to be a universal Polarion SDK in tool form.

It should first support the recurring tasks that internal users and coding agents actually perform. Broader API coverage should only be added when it solves a demonstrated need without creating major context or safety cost.

## Target User and Model Workflows

The mature MCP should support workflows like:

- "Find the requirement related to this bug"
- "Show me the current status, assignee, and links for this work item"
- "List the relevant documents in this project"
- "What fields exist for this work item type?"
- "Which enum values are valid for this field?"
- "What workflow actions are allowed on this item?"
- "Update this one work item in a narrowly scoped way"
- "Add a comment to this one item or document"
- "Add, update, or remove one explicit link between two known items"

The mature MCP should avoid encouraging workflows like:

- "Update every matching work item in one broad operation"
- "Patch an arbitrary REST path"
- "Call any write endpoint from the OpenAPI spec"
- "Fetch enormous lists by default and expect the model to reason over all of them safely"

## Proposed Capability Model

The product should be organized into four layers.

### Layer 1: Curated day-to-day tools

These are the primary interface and should cover the most common internal tasks.

Examples:

- `list_projects`
- `list_work_items`
- `get_work_item`
- `update_work_item`
- `list_documents`
- `get_document`
- `list_linked_work_items`
- `get_fields_metadata`
- `get_enum_options`
- `get_workflow_actions`

Likely v1 additions beyond the current surface may include a very small number of tightly scoped mutation tools, for example:

- add or update a single work item link
- remove a single work item link
- add or update a single comment on a work item or document

These tools should stay few in number, strongly typed, and focused on common workflows rather than raw REST fidelity.

### Layer 2: Generic read escape hatch

Add a read-only escape hatch for uncommon but legitimate information retrieval needs.

Preferred design:

- operation-based, not raw path based
- backed by allowlisted OpenAPI `operationId` values
- validated against known path and query parameters
- read-only by construction
- project-scoped by default
- explicitly biased away from wide cross-project reads

Proposed shape:

- `polarion_api_read`

High-level input:

- `project`
- `operation_id`
- `path_params`
- `query`
- optional `scope_mode`

Optional controls:

- pagination inputs
- sparse field selection
- small result-mode hints such as summary vs raw
- truncation controls with safe upper bounds

High-level behavior:

- reject non-read operations
- reject unknown or blocked operation IDs
- validate required parameters before execution
- return compact structured output by default
- require a project context for normal operation
- only permit cross-project or `/all/*` style reads through an explicit advanced mode
- enforce low default page sizes and bounded maximums
- truncate oversized responses and return continuation information rather than dumping large payloads

Why operation ID over path:

- lower hallucination risk
- easier allowlisting
- easier help/discovery
- easier auditability
- easier alignment with the bundled OpenAPI spec

Recommended scope model:

- normal mode: project-scoped reads only
- advanced mode: explicit cross-project or `/all/*` reads, only for allowlisted operations and with stricter limits

The default user and model experience should assume "work within one project."

### Layer 3: Discovery and help

The system should support low-cost discovery instead of pushing the whole API into tool definitions.

Proposed shape:

- `polarion_api_help`

High-level responsibilities:

- map a user intent or keyword to a small set of relevant operations
- describe required path params
- describe important query params
- indicate whether an operation is read-only, curated, advanced, or blocked
- provide a short example
- point the model toward a curated tool when one exists
- explain when an operation is only available in advanced all-project mode

This tool should bias the model toward curated tools first and the generic read escape hatch second.

### Layer 4: Resources and project-specific guidance

Project-specific instructions and documentation should be exposed as MCP resources rather than stuffed into tool descriptions.

These resources may be sourced from Polarion itself if that proves operationally useful.

Potential resource categories:

- Polarion query syntax guidance
- project-specific conventions
- naming conventions for documents and spaces
- field semantics for custom work item types
- workflow expectations
- "how this team uses Polarion" notes
- project-specific prompts or agent guidance stored in Polarion-managed content

The key idea is that documentation becomes fetchable context, not always-loaded context.

## Safety Model

### Read safety

Read access is still not "free." The mature product should guard against:

- accidental large fetches
- repeated retrieval of irrelevant or low-signal data
- exposure of endpoints that are technically readable but not useful or appropriate
- context rot caused by large response bodies or very high-cardinality result sets

Expected controls:

- pagination defaults
- result truncation or summarization by default
- allowlisting of generic read operations
- blocking binary or unusually large responses from the generic read tool
- project scoping by default
- explicit opt-in for advanced all-project reads
- bounded maximum page sizes
- continuation hints so the model can iteratively fetch the next slice instead of overfetching

### Write safety

The product should keep write access deliberately narrow.

Rules:

- no generic write tool
- no generic delete tool
- no generic bulk update tool
- only explicit, well-understood mutation tools
- mutation tools should target narrow objects and explicit fields
- no admin or instance-management mutation surface
- prefer per-object comment and link mutations over any multi-object write shape

When write tools exist, they should encourage a safe workflow:

1. inspect fields or workflow actions first
2. perform one narrow mutation
3. return a compact confirmation

## Documentation Strategy

Documentation should be split by purpose.

### Server instructions

Use server instructions for short global rules such as:

- use curated tools first
- use metadata discovery before unfamiliar updates
- use the generic read tool only when no curated tool fits
- fetch data incrementally instead of broadly
- stay within a single project unless an advanced all-project read is clearly needed

These instructions should stay brief and operational.

### Resources

Use resources for:

- project-specific playbooks
- internal conventions
- larger domain explanations
- examples that would otherwise bloat tool descriptions

### Tool descriptions

Tool descriptions should remain concise and decision-oriented.

They should help the model choose the tool, not teach the entire Polarion API.

## Scope Boundaries

### In scope for maturity

- stable curated tools for core workflows
- generic read escape hatch
- help/discovery over the OpenAPI surface
- resources for project-specific guidance
- stronger validation and safer defaults
- project-scoped operation by default
- lightweight telemetry for product learning
- enough tests for confidence in day-to-day use

### Out of scope for maturity target

- complete one-tool-per-endpoint coverage
- a universal generic HTTP proxy
- generic POST/PATCH/DELETE tooling
- broad bulk mutation support
- binary and job-style escape hatches unless clearly needed later
- admin and instance-management operations

## Maturity Goals

The repo should be considered ready for day-to-day use when it meets the following high-level conditions.

### 1. Clear primary workflow

Users and models can reliably complete common Polarion tasks through a small, documented set of curated tools.

### 2. Safe escape hatch

Uncommon read needs can be satisfied through a generic read tool without exposing broad mutation or arbitrary-path risk, and without encouraging large unbounded fetches.

### 3. Good discoverability

Models can discover:

- which curated tool to use
- which operation IDs are available for generic reads
- where project-specific guidance lives

without needing the full OpenAPI spec in context.

### 4. Strong defaults

Default behavior should discourage wide, low-signal access patterns.

Examples:

- paginated responses
- compact output
- bounded help responses
- explicit warnings for advanced operations
- project scope by default
- truncation before large payloads reach the model

### 5. Confidence through tests

The server should have enough tests to cover:

- tool schema validation
- happy-path request shaping
- error handling
- auth handling
- generic read allowlist behavior
- help/discovery behavior

### 6. Operational clarity

It should be obvious:

- which tools are safe and common
- which tools are advanced
- which operations are intentionally blocked
- where project guidance comes from
- when all-project read mode is being used

### 7. Product feedback loop

The MCP should provide lightweight internal telemetry or logs so maintainers can learn from real usage without relying on non-technical users to manually report hot paths.

Useful signals include:

- which tools are called most often
- which generic read operation IDs are used repeatedly
- which help queries fail to route cleanly to a tool
- where models frequently need multiple discovery steps before a write

This feedback should be used to decide when a generic read pattern deserves promotion into a dedicated curated tool.

## Suggested Implementation Phases

This is not a detailed plan, but a sequencing guide.

### Phase 1: stabilize current curated surface

- keep the current small tool set
- tighten descriptions and server instructions
- confirm tests around the existing tools
- document intended usage patterns

### Phase 2: add discovery

- introduce `polarion_api_help`
- surface a small allowlisted view of relevant read operations
- bias responses toward curated tools first
- explain project-scoped defaults and advanced all-project mode

### Phase 3: add generic read escape hatch

- introduce `polarion_api_read`
- key it by `operation_id`
- enforce read-only allowlists
- keep outputs compact, paginated, and truncated by default
- require project scope unless advanced all-project mode is explicitly requested

### Phase 4: add resource-backed project guidance

- expose project and team conventions as resources
- optionally source those resources from Polarion-managed content
- make those resources discoverable from help responses

### Phase 5: harden for daily use

- expand tests
- tune defaults from real usage
- adjust curated tools based on recurring internal tasks
- add lightweight telemetry or structured logs for tool and operation usage
- continue to resist generic write expansion unless a specific safe case emerges

## Open Questions

These questions should be resolved before locking the implementation plan:

- Which read operations should be allowlisted for the first generic read release?
- Should operation IDs be grouped by tags, risk class, or internal use case?
- What format should `polarion_api_help` return for best model usability?
- Which project-specific docs should live as resources first?
- If docs are stored in Polarion, what content model and governance should own them?
- Which existing curated tools are truly essential, and which additional ones are justified by repeated day-to-day use?
- Which comment and link mutations are safe and common enough for the first write expansion?
- What telemetry is acceptable for internal deployment, and what retention/privacy rules should apply?

## Non-Goals

To avoid future drift, the following are explicit non-goals unless requirements change:

- mirroring the entire OpenAPI spec into MCP tools
- maximizing endpoint count
- exposing unrestricted write capability
- optimizing for theoretical completeness over practical reliability

## Summary

The intended mature Polarion MCP is:

- curated for common internal workflows
- optimized for deep, sequential model work
- resistant to wide, unsafe mutation patterns
- supported by resources and discovery instead of bloated tool schemas
- flexible enough to read beyond the curated set when needed
- intentionally scoped to working with Polarion project data rather than administering Polarion itself

The central product choice is deliberate:

use a small number of excellent tools, one safe generic read escape hatch, and strong guidance, rather than turning the entire REST API into the MCP surface.
