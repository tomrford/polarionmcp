import { describe, expect, test } from "vitest";
import { resolveAttachmentContentUrl } from "../src/attachment-routes";

describe("resolveAttachmentContentUrl", () => {
  test("accepts a Polarion-relative content URL", () => {
    const resolved = resolveAttachmentContentUrl({
      contentUrl: "/projects/PRJ/workitems/WI-1/attachments/A-1/content?revision=42",
    });
    expect("url" in resolved).toBe(true);
    if ("url" in resolved) {
      expect(resolved.url.toString()).toBe(
        "https://example.invalid/projects/PRJ/workitems/WI-1/attachments/A-1/content?revision=42",
      );
    }
  });

  test("builds a content URL from a resource id", () => {
    const resolved = resolveAttachmentContentUrl({
      resourceType: "workitem_attachments",
      resourceId: "PRJ/WI-1/A-1",
      revision: "7",
    });
    expect("url" in resolved).toBe(true);
    if ("url" in resolved) {
      expect(resolved.url.toString()).toBe(
        "https://example.invalid/projects/PRJ/workitems/WI-1/attachments/A-1/content?revision=7",
      );
    }
  });

  test("rejects a cross-origin content URL", () => {
    const resolved = resolveAttachmentContentUrl({
      contentUrl: "https://attacker.invalid/projects/PRJ/workitems/WI-1/attachments/A-1/content",
    });
    expect("error" in resolved).toBe(true);
    if ("error" in resolved) {
      expect(resolved.error.message).toBe("Rejected attachment URL");
    }
  });
});
