# Codemode Friction Log

Observed friction from an LLM client using the `code` MCP tool.

## 1. Response Shapes Vary By Endpoint

Generated operations stay close to the Polarion wire format rather than normalizing
everything into one shared `{ items, pagination }` shape. That means scripts still have
to adapt to the specific endpoint they call:

- list endpoints return JSON:API collections under `data` with optional `included`, `links`,
  and `meta`
- single-resource reads return a single `data` object
- `204` writes normalize to `{ ok: true }`
- metadata endpoints return whatever Polarion returns for that route rather than a custom wrapper

## Priority Summary

| # | Friction | Impact | Effort |
|---|----------|--------|--------|
| 1 | Response shapes vary by endpoint | Medium — generic mapping code is harder | Medium |
