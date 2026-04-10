import { describe, expect, test } from "./test/test.ts";
import {
  authHeaders,
  errorResult,
  fieldsParam,
  interpolatePath,
  ok,
  toQueryString,
} from "./helpers.ts";
import { runWithPolarionAccessToken } from "./request-context.ts";

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
  test("wraps payload as compact JSON text", () => {
    const r = ok({ items: [], pagination: {} });
    expect(r).not.toHaveProperty("isError");
    expect(r.content).toHaveLength(1);
    const parsed = JSON.parse(r.content[0]!.text);
    expect(parsed).toEqual({ items: [], pagination: {} });
    expect(r.content[0]!.text).toBe('{"items":[],"pagination":{}}');
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

describe("authHeaders", () => {
  test("prefers bridged token", async () => {
    const headers = await runWithPolarionAccessToken("token-a", async () =>
      authHeaders({
        authInfo: { token: "token-b" },
        requestInfo: { headers: { authorization: "Bearer token-c" } },
      }));

    expect(headers).toEqual({ Authorization: "Bearer token-a" });
  });

  test("throws when no token is available", () => {
    expect(() => authHeaders({})).toThrow("No Polarion access token available");
  });
});

describe("interpolatePath", () => {
  test("fills template placeholders", () => {
    expect(
      interpolatePath("/projects/{projectId}/workitems/{workItemId}", {
        projectId: "MYPROJ",
        workItemId: "REQ-1",
      }),
    ).toBe("/projects/MYPROJ/workitems/REQ-1");
  });

  test("encodes path segments", () => {
    expect(
      interpolatePath("/spaces/{spaceId}/documents/{documentName}", {
        spaceId: "My Space",
        documentName: "Spec / Plan",
      }),
    ).toBe("/spaces/My%20Space/documents/Spec%20%2F%20Plan");
  });

  test("throws for missing path parameter", () => {
    expect(() =>
      interpolatePath("/projects/{projectId}/workitems/{workItemId}", {
        projectId: "MYPROJ",
      })
    ).toThrow("Missing required path parameter: workItemId");
  });
});

describe("toQueryString", () => {
  test("returns empty string for empty input", () => {
    expect(toQueryString(undefined)).toBe("");
  });

  test("serializes flat query values", () => {
    expect(
      toQueryString({
        query: "status:open",
        "page[size]": 20,
        revision: "1234",
      }),
    ).toBe("?query=status%3Aopen&page%5Bsize%5D=20&revision=1234");
  });

  test("serializes nested query values with bracket notation", () => {
    expect(
      toQueryString({
        fields: { workitems: "title,status" },
        page: { size: 20, number: 2 },
      }),
    ).toBe(
      "?fields%5Bworkitems%5D=title%2Cstatus&page%5Bsize%5D=20&page%5Bnumber%5D=2",
    );
  });

  test("serializes array values as repeated keys", () => {
    expect(
      toQueryString({
        include: ["project", "author"],
      }),
    ).toBe("?include=project&include=author");
  });
});

