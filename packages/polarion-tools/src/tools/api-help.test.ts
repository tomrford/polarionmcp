import { describe, expect, test } from "../test/test.ts";
import { helpSearch } from "./api-help.ts";

describe("helpSearch", () => {
  test("returns summary when no filters are provided", () => {
    const result = helpSearch(undefined, undefined, false);

    expect(result.summary.total_operations).toBeGreaterThan(0);
    expect(result.summary.by_resource?.some((entry) => entry.resource === "workitems")).toBe(true);
    expect(result.curated_recommendations.length).toBeGreaterThan(0);
  });

  test("finds curated operations by keyword", () => {
    const result = helpSearch("workflow", "workitems", false);

    expect(result.summary.total_matches).toBeGreaterThan(0);
    expect(
      result.curated_recommendations.some(
        (entry) => entry.operation_id === "getWorkflowActionsForWorkItem",
      ),
    ).toBe(true);
  });

  test("filters by resource type", () => {
    const result = helpSearch(undefined, "documents", false);

    expect(result.summary.total_matches).toBeGreaterThan(0);
    expect(
      result.curated_recommendations.every(
        (entry) => entry.resource_type === "documents",
      ),
    ).toBe(true);
    expect(
      result.generic_read_options?.every(
        (entry) => entry.resource_type === "documents",
      ),
    ).toBe(true);
  });

  test("hides blocked operations by default", () => {
    const result = helpSearch("attachment content", "documents", false);

    expect(result.blocked_matches).toBeUndefined();
  });

  test("includes blocked operations when requested", () => {
    const result = helpSearch("downloads the file content", "documents", true);

    expect(result.blocked_matches?.length).toBeGreaterThan(0);
    expect(
      result.blocked_matches?.some(
        (entry) => entry.operation_id === "getDocumentAttachmentContent",
      ),
    ).toBe(true);
  });
});
