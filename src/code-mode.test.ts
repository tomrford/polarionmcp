import { describe, expect, test } from "./test/test.ts";
import { isCodeModeProcess, isCodeModeRequest } from "./code-mode.ts";

describe("isCodeModeRequest", () => {
  test("defaults to code mode", () => {
    expect(isCodeModeRequest(new URL("http://localhost/mcp"))).toBe(true);
  });

  test("turns code mode off only for the exact false value", () => {
    expect(isCodeModeRequest(new URL("http://localhost/mcp?codemode=false"))).toBe(false);
    expect(isCodeModeRequest(new URL("http://localhost/mcp?codemode=off"))).toBe(true);
    expect(isCodeModeRequest(new URL("http://localhost/mcp?codemode=true"))).toBe(true);
  });
});

describe("isCodeModeProcess", () => {
  const env = (values: Record<string, string | undefined>) => ({
    get(name: string) {
      return values[name];
    },
  });

  test("defaults to code mode", () => {
    expect(isCodeModeProcess([], env({}))).toBe(true);
  });

  test("turns code mode off from --codemode=false or a following false value", () => {
    expect(isCodeModeProcess(["--stdio", "--codemode=false"], env({}))).toBe(false);
    expect(isCodeModeProcess(["--stdio", "--codemode", "false"], env({}))).toBe(false);
  });

  test("turns code mode off from CODEMODE=false", () => {
    expect(isCodeModeProcess(["--stdio"], env({ CODEMODE: "false" }))).toBe(false);
    expect(isCodeModeProcess(["--stdio"], env({ CODEMODE: "off" }))).toBe(true);
  });

  test("prefers an explicit CLI flag over env", () => {
    expect(isCodeModeProcess(["--codemode=false"], env({ CODEMODE: "true" }))).toBe(false);
  });
});
