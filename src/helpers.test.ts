import { describe, expect, test } from "./test/test.ts";
import {
  authHeaders,
  errorResult,
  fieldsParam,
  interpolatePath,
  ok,
  pagination,
  toQueryString,
  truncateResponse,
} from "./helpers.ts";
import { runWithPolarionAccessToken } from "./request-context.ts";

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

describe("truncateResponse", () => {
  test("returns unchanged payload when under limits", () => {
    const payload = { data: [{ id: "1" }, { id: "2" }] };
    expect(
      truncateResponse(payload, { maxItems: 10, maxChars: 1000 }),
    ).toEqual({ data: payload });
  });

  test("truncates by item count", () => {
    const payload = {
      data: [{ id: "1" }, { id: "2" }, { id: "3" }],
    };

    expect(
      truncateResponse(payload, { maxItems: 2, maxChars: 1000 }),
    ).toEqual({
      data: { data: [{ id: "1" }, { id: "2" }] },
      truncation: {
        reason: "item_limit",
        original_item_count: 3,
        returned_item_count: 2,
        max_items: 2,
        max_chars: 1000,
        hint: "Use page_number and page_size to fetch the next slice.",
      },
    });
  });

  test("truncates by char count when needed", () => {
    const payload = {
      data: [
        { id: "1", text: "a".repeat(200) },
        { id: "2", text: "b".repeat(200) },
      ],
    };

    const result = truncateResponse(payload, { maxItems: 10, maxChars: 260 });
    expect(result.truncation?.reason).toBe("char_limit");
    expect(result.truncation?.original_item_count).toBe(2);
    expect(result.truncation?.returned_item_count).toBe(1);
    expect(result.data).toEqual({
      data: [{ id: "1", text: "a".repeat(200) }],
    });
  });
});
