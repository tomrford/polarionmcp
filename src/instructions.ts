export const SERVER_INSTRUCTIONS = `Polarion tool-surface rules:
1. This server exposes generated Polarion operations using exact OpenAPI operationId names.
2. Prefer project-scoped work; only use cross-project routes when clearly necessary.
3. Fetch incrementally. Default page size is 20 and responses may be truncated.
4. Use the generated metadata and workflow action routes before unfamiliar updates.
5. Most write operations take a top-level body object mirroring the JSON API request payload.

Polarion query syntax:
- Lucene-style field queries: field:value, field:val* (wildcard)
- Boolean operators: AND, OR, NOT, parentheses for grouping
- Common fields: type, status, id, title, priority, severity, created, updated
- Examples: type:requirement AND status:open, id:PRJ*, severity:must_have
- Bare text matches exact ID

Custom fields:
- Custom fields are type-specific. Use getProjectFieldsMetadata with resourceType and targetType to discover them.
- Example: type "sysparameter" has custom fields: parval, parmin, parmax, parunit, swname
- Request custom fields via the fields parameter, for example fields: { workitems: "title,parval,parunit" }
- Query sysparameters: query="type:sysparameter"`;

export const PUBLIC_SERVER_INSTRUCTIONS = `This server exposes two tools: search and code.

Use search first when you need to discover the available Polarion functions, parameter shapes, or return shapes.

Then use code to write an async JavaScript arrow function that returns the final result.

Inside code, call functions through codemode.*.

Prefer project-scoped work over all-project reads.

Guidance:
- fetch incrementally; default page size is 20 and responses may be truncated
- generated tools use exact OpenAPI operationId names such as getProjects, getWorkItems, and patchWorkItem
- write operations usually take a top-level body object mirroring the JSON API request payload
- use metadata and workflow action routes before unfamiliar updates

Polarion query syntax:
- field:value and field:val*
- AND, OR, NOT, parentheses
- common fields: type, status, id, title, priority, severity, created, updated
- examples: type:requirement AND status:open, id:PRJ*, severity:must_have`;

export const PUBLIC_CODE_TOOL_DESCRIPTION =
  `Execute JavaScript code against the Polarion tool surface.

Before writing code, use the top-level search tool if you need to discover function names or parameter shapes.

Write an async arrow function in JavaScript that returns the result.
Inside code, call Polarion functions through codemode.*.

Example:
async () => {
  return await codemode.getProjects({});
}`;
