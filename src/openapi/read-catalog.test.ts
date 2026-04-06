import { describe, expect, test } from "../test/test.ts";
import { READ_OPERATION_CATALOG, READ_OPERATION_CATALOG_BY_ID } from "./read-catalog.ts";
import { getReadPolicy, getResolvedReadOperations, resolveReadOperation } from "./read-policy.ts";

describe("read catalog", () => {
  test("covers all GET operations from the bundled spec", () => {
    expect(READ_OPERATION_CATALOG).toHaveLength(123);
  });

  test("lookup map resolves entries by operation id", () => {
    expect(READ_OPERATION_CATALOG_BY_ID.get("getWorkItems")?.pathTemplate).toBe(
      "/projects/{projectId}/workitems",
    );
    expect(READ_OPERATION_CATALOG_BY_ID.get("getProjectFieldsMetadata")?.pathTemplate).toBe(
      "/projects/{projectId}/actions/getFieldsMetadata",
    );
  });

  test("path parameters match placeholders", () => {
    for (const entry of READ_OPERATION_CATALOG) {
      const placeholders = Array.from(
        entry.pathTemplate.matchAll(/\{([^}]+)\}/g),
        (match) => match[1]!,
      ).sort();
      expect(entry.pathParamNames).toEqual(placeholders);
    }
  });

  test("represents expected project and all-scope operations", () => {
    expect(READ_OPERATION_CATALOG_BY_ID.get("getWorkItems")?.isProjectScoped).toBe(true);
    expect(READ_OPERATION_CATALOG_BY_ID.get("getAllWorkItems")?.isAllScope).toBe(true);
    expect(READ_OPERATION_CATALOG_BY_ID.get("getProjects")?.isProjectScoped).toBe(false);
  });
});

describe("read policy", () => {
  test("classifies curated operations with preferred tools", () => {
    expect(getReadPolicy("getWorkItems")).toEqual({
      mode: "curated",
      reason: "Covered by a curated high-signal tool.",
      preferredTool: "list_work_items",
      resourceGroup: "workitems",
      advancedWarning: undefined,
    });
  });

  test("classifies advanced global operations", () => {
    expect(getReadPolicy("getUsers")).toEqual({
      mode: "advanced",
      reason: "Global read surface should require explicit advanced intent.",
      preferredTool: undefined,
      resourceGroup: "users",
      advancedWarning:
        "This operation is global rather than project-scoped. Use only when curated or project-scoped reads do not fit.",
    });
  });

  test("classifies blocked operations", () => {
    expect(getReadPolicy("getDocumentAttachmentContent")).toEqual({
      mode: "blocked",
      reason:
        "Blocked because the endpoint is binary, admin-like, export-oriented, or otherwise low-signal for MCP usage.",
      preferredTool: undefined,
      resourceGroup: "documents",
      advancedWarning: undefined,
    });
  });

  test("resolves full operation metadata", () => {
    const resolved = resolveReadOperation("getDocument");
    expect(resolved?.catalogEntry.pathTemplate).toBe(
      "/projects/{projectId}/spaces/{spaceId}/documents/{documentName}",
    );
    expect(resolved?.policy.mode).toBe("curated");
  });

  test("every catalog entry has policy coverage", () => {
    const resolved = getResolvedReadOperations();
    expect(resolved).toHaveLength(READ_OPERATION_CATALOG.length);
    for (const entry of resolved) {
      expect(entry.policy.resourceGroup).toBe(entry.catalogEntry.resourceGroup);
    }
  });
});
