import { describe, expect, test } from "../test/test.ts";
import { buildReadUrl } from "./generic-read.ts";

describe("buildReadUrl", () => {
  test("builds a project-scoped read URL with pagination", () => {
    const result = buildReadUrl(
      "https://polarion.example.com/polarion/rest/v1",
      "getWorkItems",
      "PRJ",
      undefined,
      { query: "type:requirement", fields: { workitems: "title,status" } },
      "project",
      20,
      2,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.url).toBe(
      "https://polarion.example.com/polarion/rest/v1/projects/PRJ/workitems?query=type%3Arequirement&fields%5Bworkitems%5D=title%2Cstatus&page%5Bsize%5D=20&page%5Bnumber%5D=2",
    );
    expect(result.policy.mode).toBe("curated");
  });

  test("builds an advanced all-project read when opted in", () => {
    const result = buildReadUrl(
      "https://polarion.example.com/polarion/rest/v1",
      "getUsers",
      undefined,
      undefined,
      { fields: { users: "name" } },
      "all",
      10,
      1,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.url).toBe(
      "https://polarion.example.com/polarion/rest/v1/users?fields%5Busers%5D=name&page%5Bsize%5D=10&page%5Bnumber%5D=1",
    );
    expect(result.policy.mode).toBe("advanced");
  });

  test("rejects unknown operation ids with suggestions", () => {
    const result = buildReadUrl(
      "https://polarion.example.com/polarion/rest/v1",
      "getWorkThing",
      undefined,
      undefined,
      undefined,
      "project",
      20,
      1,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.message).toBe("Unknown operation_id: getWorkThing");
    expect(result.error.details).toContain("Suggestions:");
  });

  test("rejects blocked operations", () => {
    const result = buildReadUrl(
      "https://polarion.example.com/polarion/rest/v1",
      "getDocumentAttachmentContent",
      "PRJ",
      {
        spaceId: "_default",
        documentName: "Spec",
        attachmentId: "1",
      },
      undefined,
      "project",
      20,
      1,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.status_code).toBe(403);
    expect(result.error.message).toBe("Blocked operation: getDocumentAttachmentContent");
  });

  test("rejects advanced operations without all scope", () => {
    const result = buildReadUrl(
      "https://polarion.example.com/polarion/rest/v1",
      "getUsers",
      undefined,
      undefined,
      undefined,
      "project",
      20,
      1,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.status_code).toBe(403);
    expect(result.error.message).toBe('Operation getUsers requires scope_mode="all"');
  });

  test("throws when required path params are missing", () => {
    expect(() =>
      buildReadUrl(
        "https://polarion.example.com/polarion/rest/v1",
        "getDocument",
        "PRJ",
        { spaceId: "_default" },
        undefined,
        "project",
        20,
        1,
      )
    ).toThrow("Missing required path parameter: documentName");
  });

  test("throws when unsupported query params are provided", () => {
    expect(() =>
      buildReadUrl(
        "https://polarion.example.com/polarion/rest/v1",
        "getWorkItem",
        "PRJ",
        { workItemId: "REQ-1" },
        { bogus: "value" },
        "project",
        20,
        1,
      )
    ).toThrow("Unsupported query parameter(s): bogus");
  });
});
