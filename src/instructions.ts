export const SERVER_INSTRUCTIONS = `Polarion tool-surface rules:
1. Prefer curated tools over polarion_api_read for common tasks.
2. Use polarion_api_help before polarion_api_read when unsure which operation fits.
3. Prefer project-scoped work; only use all-project reads when clearly necessary.
4. Fetch incrementally. Default page size is 20 and responses may be truncated.
5. Use get_fields_metadata before unfamiliar updates or custom-field queries.
6. Check workflow actions before changing status-like fields.
7. Check existing links before creating or updating a work item link.

Polarion query syntax:
- Lucene-style field queries: field:value, field:val* (wildcard)
- Boolean operators: AND, OR, NOT, parentheses for grouping
- Common fields: type, status, id, title, priority, severity, created, updated
- Examples: type:requirement AND status:open, id:PRJ*, severity:must_have
- Bare text matches exact ID

Custom fields:
- Custom fields are type-specific. Use get_fields_metadata with target_type to discover them.
- Example: type "sysparameter" has custom fields: parval, parmin, parmax, parunit, swname
- Request custom fields via the fields param: fields="title,parval,parunit"
- Query sysparameters: query="type:sysparameter"`;

export const PUBLIC_SERVER_INSTRUCTIONS = `This server exposes one tool: code.

Write an async JavaScript arrow function that returns the final result.

Inside code, use the generated codemode tool catalog and call functions through codemode.*.

Prefer project-scoped work over all-project reads.

Guidance:
- fetch incrementally; default page size is 20 and responses may be truncated
- use get_fields_metadata before unfamiliar updates or custom-field queries
- use get_workflow_actions before status-like changes
- check existing links before creating or updating a work item link

Polarion query syntax:
- field:value and field:val*
- AND, OR, NOT, parentheses
- common fields: type, status, id, title, priority, severity, created, updated
- examples: type:requirement AND status:open, id:PRJ*, severity:must_have`;
