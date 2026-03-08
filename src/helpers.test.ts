import { describe, test, expect } from "bun:test";
import { pagination, errorResult, ok, fieldsParam } from "./helpers.ts";

describe("pagination", () => {
  test("returns metadata with all fields", () => {
    const p = pagination(1500, 50, 1, "https://next");
    expect(p).toEqual({
      total: 1500,
      page_size: 50,
      page_number: 1,
      has_next: true,
    });
  });

  test("has_next false when nextLink undefined", () => {
    const p = pagination(10, 50, 1, undefined);
    expect(p.has_next).toBe(false);
  });

  test("total can be undefined", () => {
    const p = pagination(undefined, 25, 2, undefined);
    expect(p.total).toBeUndefined();
  });
});

describe("errorResult", () => {
  test("wraps payload as JSON text with isError", () => {
    const r = errorResult({ error: true, message: "fail" });
    expect(r.isError).toBe(true);
    expect(r.content).toHaveLength(1);
    expect(r.content[0]!.type).toBe("text");
    expect(JSON.parse(r.content[0]!.text)).toEqual({
      error: true,
      message: "fail",
    });
  });
});

describe("ok", () => {
  test("wraps payload as pretty-printed JSON text", () => {
    const r = ok({ items: [], pagination: {} });
    expect(r).not.toHaveProperty("isError");
    expect(r.content).toHaveLength(1);
    const parsed = JSON.parse(r.content[0]!.text);
    expect(parsed).toEqual({ items: [], pagination: {} });
    // pretty-printed = contains newlines
    expect(r.content[0]!.text).toContain("\n");
  });
});

describe("fieldsParam", () => {
  test("returns undefined when no fields", () => {
    expect(fieldsParam("workitems")).toBeUndefined();
    expect(fieldsParam("workitems", undefined)).toBeUndefined();
  });

  test("returns undefined for empty string", () => {
    expect(fieldsParam("workitems", "")).toBeUndefined();
  });

  test("wraps fields in resource type key", () => {
    expect(fieldsParam("workitems", "title,status")).toEqual({ workitems: "title,status" });
  });

  test("uses provided resource type as key", () => {
    expect(fieldsParam("documents", "title")).toEqual({ documents: "title" });
  });
});
