import { describe, expect, test } from "vitest";
import { polarionConfig } from "../src/config";
import { DEFAULT_GUIDELINES } from "../src/guidelines";

describe("polarionConfig guidelines", () => {
  test("uses the built-in instructions when unset", () => {
    expect(polarionConfig().guidelines).toBe(DEFAULT_GUIDELINES);
  });

  test("appends deployment guidance to the built-in instructions", () => {
    expect(polarionConfig({ guidelines: "  Never delete work items.\n" }).guidelines).toBe(
      `${DEFAULT_GUIDELINES}\n\n# Custom Guidance\n\nNever delete work items.`,
    );
  });
});
