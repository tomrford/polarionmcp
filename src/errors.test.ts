import { describe, expect, test } from "bun:test";
import { makeError, httpError, networkError } from "./errors.ts";

describe("errors", () => {
  test("makeError returns structured error", () => {
    const e = makeError(404, "Not Found", "details");
    expect(e).toEqual({
      error: true,
      status_code: 404,
      message: "Not Found",
      details: "details",
    });
  });

  test("httpError formats status and body", () => {
    const e = httpError(401, { msg: "bad token" });
    expect(e.error).toBe(true);
    expect(e.status_code).toBe(401);
    expect(e.message).toBe("HTTP 401");
    expect(e.details).toContain("bad token");
  });

  test("networkError wraps Error instance", () => {
    const e = networkError(new Error("ECONNREFUSED"));
    expect(e.error).toBe(true);
    expect(e.status_code).toBe(0);
    expect(e.details).toBe("ECONNREFUSED");
  });

  test("networkError wraps non-Error", () => {
    const e = networkError("timeout");
    expect(e.details).toBe("timeout");
  });
});
