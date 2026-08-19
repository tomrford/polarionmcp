import { describe, expect, test } from "vitest";
import { normalizeCode, withTimeout } from "../src/tools/code";

describe("normalizeCode", () => {
  test("keeps an arrow function after leading comments", () => {
    expect(normalizeCode("// query projects\nasync () => await codemode.getProjects({})")).toBe(
      "// query projects\nasync () => await codemode.getProjects({})",
    );
    expect(normalizeCode("/* fetch */\nasync () => {\n  return 1;\n}")).toBe(
      "/* fetch */\nasync () => {\n  return 1;\n}",
    );
  });

  test("wraps a statement body", () => {
    expect(normalizeCode("return 1;")).toBe("async () => {\nreturn 1;\n}");
  });
});

describe("withTimeout", () => {
  test("rejects when the promise does not settle", async () => {
    await expect(withTimeout(new Promise(() => {}), 10, "timed out")).rejects.toThrow("timed out");
  });

  test("resolves when the promise settles first", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 50, "timed out")).resolves.toBe("ok");
  });
});
