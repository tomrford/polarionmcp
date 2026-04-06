Default to using Deno in this repo.

- Use `deno task <name>` instead of `npm run <script>` or `bun run <script>`
- Use `deno test` instead of `jest` or `vitest`
- Use `deno run` for local scripts and server entrypoints
- Use `Deno.serve()` for HTTP server work in this repo
- Use `Deno.readTextFile` / `Deno.writeTextFile` for simple file IO
- Keep npm dependencies behind Deno import maps or `npm:` specifiers

## APIs

- `Deno.serve()` for the MCP HTTP server
- Web APIs first unless there is a repo-local reason not to
- Keep auth/env handling explicit; Deno does not auto-load `.env`

## Testing

Use `deno test` to run tests.

```ts#index.test.ts
import { describe, expect, test } from "./src/test/test.ts";

describe("hello world", () => {
  test("works", () => {
    expect(1).toBe(1);
  });
});
```
