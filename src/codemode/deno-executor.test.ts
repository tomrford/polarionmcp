import { describe, expect, test } from "../test/test.ts";
import { DenoSubprocessExecutor } from "./deno-executor.ts";

describe("DenoSubprocessExecutor", () => {
  test("sanitizes tool names, supports concurrent calls, and captures logs", async () => {
    const executor = new DenoSubprocessExecutor();

    const result = await executor.execute(
      `async () => {
        const [left, right] = await Promise.all([
          codemode.slow_tool({ value: 1 }),
          codemode.fast_tool({ value: 2 }),
        ]);
        console.warn("joined", left, right);
        return { left, right };
      }`,
      [
        {
          name: "codemode",
          fns: {
            "slow-tool": async (args) => {
              const { value } = args as { value: number };
              await new Promise((resolve) => setTimeout(resolve, 20));
              return value + 10;
            },
            "fast.tool": async (args) => {
              const { value } = args as { value: number };
              return value + 20;
            },
          },
        },
      ],
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ left: 11, right: 22 });
    expect(result.logs).toContain("[warn] joined 11 22");
  });

  test("times out runaway code", async () => {
    const executor = new DenoSubprocessExecutor({ timeout: 50 });

    const result = await executor.execute(
      "async () => await new Promise(() => {})",
      [{ name: "codemode", fns: {} }],
    );

    expect(result.error).toBe("Execution timed out");
  });

  test("supports common console methods without throwing", async () => {
    const executor = new DenoSubprocessExecutor();

    const result = await executor.execute(
      `async () => {
        console.info("info");
        console.debug("debug");
        console.trace("trace");
        console.assert(false, "failed");
        return "ok";
      }`,
      [{ name: "codemode", fns: {} }],
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toBe("ok");
    expect(result.logs).toContain("info");
    expect(result.logs).toContain("debug");
    expect(result.logs).toContain("trace");
    expect(result.logs).toContain("[error] Assertion failed: failed");
  });
});
