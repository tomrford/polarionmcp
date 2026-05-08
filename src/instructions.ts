export const PUBLIC_SERVER_INSTRUCTIONS = `This server allows you to interact with Polarion.

It exposes a search tool, a code tool and optionally a set of custom instructions.

Use search first when you need to discover the available Polarion functions, parameter shapes, or return shapes.

Then use code to write an async JavaScript arrow function that returns the final result.

Inside code, call functions through codemode.*.

Prefer project-scoped work over all-project reads.

Guidance:
- generated list operations fetch all Polarion pages and return full collections
- use project scope, query filters, and fields to keep reads targeted
- generated tools use exact OpenAPI operationId names such as getProjects, getWorkItems, and patchWorkItem
- generated reads return stable top-level envelopes: collections use { kind: "collection", items, ... }, single resources use { kind: "resource", item, ... }, and 204 writes use { ok: true }
- write operations usually take a top-level body object mirroring the JSON API request payload
- if the final code result is truncated, your script still ran; rewrite the return value to send a smaller filtered or aggregated result
- use metadata and workflow action routes before unfamiliar updates

Polarion query syntax:
- field:value and field:val*
- AND, OR, NOT, parentheses
- common fields: type, status, id, title, priority, severity, created, updated
- examples: type:requirement AND status:open, id:PRJ*, severity:must_have`;

export const PUBLIC_CODE_TOOL_DESCRIPTION = `Execute JavaScript code against the Polarion tool surface.

Before writing code, use the top-level search tool if you need to discover function names or parameter shapes.

Write an async arrow function in JavaScript that returns the result.
Inside code, call Polarion functions through codemode.*.
If the returned code result is truncated, the script already ran successfully; return a smaller filtered or aggregated value and rerun.

Example:
async () => {
  return await codemode.getProjects({});
}`;
