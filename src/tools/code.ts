import { env } from "cloudflare:workers";
import { DynamicWorkerExecutor, normalizeCode } from "@cloudflare/codemode";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { generatedOperationNames } from "../catalog";
import { CODE_TOOL_DESCRIPTION } from "../guidelines";
import { callGeneratedOperation } from "../generated/register-generated-tools";
import { formatError } from "../helpers";
import { getPolarionAccessToken, runWithPolarionAccessToken } from "../request-context";
import { truncateResponse } from "../truncate";

const CODE_INPUT_SCHEMA = z.object({
  code: z.string().describe("JavaScript async arrow function to execute"),
});

// Stop slow scripts with a tool error before the supervisor's 30s request deadline (which
// also counts queue time) kills the host and returns a 504.
const EXECUTION_TIMEOUT_MS = 25_000;

async function runCode(code: string, token: string) {
  // Operations run host-side through Workers RPC, so the sandbox never sees the token.
  const fns = Object.fromEntries(
    generatedOperationNames().map((name) => [
      name,
      (args: unknown) =>
        runWithPolarionAccessToken(token, () => callGeneratedOperation(name, args ?? {})),
    ]),
  );
  const executor = new DynamicWorkerExecutor({
    loader: env.LOADER,
    timeout: EXECUTION_TIMEOUT_MS,
    globalOutbound: null,
  });
  return await executor.execute(wrapForExecutor(code), [{ name: "codemode", fns }]);
}

// The executor reports failures as err.message, so a thrown string or an empty Error would
// look like success. Rethrow everything as an Error with a non-empty message. normalizeCode
// also keeps a trailing semicolon after an arrow function, which cannot be called as written.
function wrapForExecutor(code: string) {
  return `async () => {
  try {
    return await (${normalizeCode(code).replace(/;+\s*$/, "")}
    )();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message || "Code threw an empty error");
  }
}`;
}

export function registerCodeTool(server: McpServer) {
  server.registerTool(
    "code",
    {
      title: "Polarion code executor",
      description: CODE_TOOL_DESCRIPTION,
      inputSchema: CODE_INPUT_SCHEMA,
      annotations: { title: "Polarion code executor" },
    },
    async ({ code }) => {
      try {
        const token = getPolarionAccessToken();
        if (!token) throw new Error("No Polarion access token available");
        const { result, error } = await runCode(code, token);
        if (error) throw new Error(error);
        return { content: [{ type: "text" as const, text: truncateResponse(result) }] };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${formatError(error)}` }],
          isError: true,
        };
      }
    },
  );
}
