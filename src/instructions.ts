export const SERVER_INSTRUCTIONS = `Polarion MCP usage rules:
1. Prefer curated tools over polarion_api_read for common tasks.
2. Use polarion_api_help before polarion_api_read when unsure which operation fits.
3. Prefer project-scoped work; only use all-project reads when clearly necessary.
4. Fetch incrementally. Default page size is 20 and responses may be truncated.
5. Use get_fields_metadata before unfamiliar updates or custom-field queries.
6. Check workflow actions before changing status-like fields.
7. Check existing links before creating or updating a work item link.

Resources:
- Read polarion://guides/query-syntax for query syntax help.
- Read polarion://guides/mcp-usage for tool selection and safety guidance.

Polarion query syntax reference:
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
