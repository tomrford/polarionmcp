import { describe, expect, test } from "vitest";
import { generatedOperationNames, searchCatalog } from "../src/catalog";

describe("searchCatalog", () => {
  test("finds workflow work item operations", () => {
    const payload = searchCatalog("workflow workitems", 8);
    expect(payload.total_matches).toBeGreaterThan(0);
    expect(
      payload.matches.some((entry) => entry.callable === "codemode.getWorkflowActionsForWorkItem"),
    ).toBe(true);
    expect(
      payload.matches.every(
        (entry) =>
          typeof entry.input_summary === "string" && typeof entry.output_summary === "string",
      ),
    ).toBe(true);
  });

  test("lists curated Polarion operationIds", () => {
    const names = generatedOperationNames();
    expect(names).toContain("getProjects");
    expect(names).toContain("getWorkItems");
    expect(names).toContain("patchWorkItem");
    expect(names).not.toContain("createProject");
    expect(names).not.toContain("list_projects");
  });
});
