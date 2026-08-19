import { env, exports, WorkerEntrypoint } from "cloudflare:workers";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { generatedOperationNames } from "../catalog";
import { CODE_TOOL_DESCRIPTION } from "../guidelines";
import { callGeneratedOperation } from "../generated/register-generated-tools";
import { getPolarionAccessToken, runWithPolarionAccessToken } from "../request-context";
import { truncateResponse } from "../truncate";

type CodeExecutorEntrypoint = {
  evaluate(): Promise<{ result: unknown; err?: string; stack?: string }>;
};

export class PolarionDispatcher extends WorkerEntrypoint<Env, { token: string }> {
  async call(name: string, args: unknown) {
    const token = this.ctx.props.token;
    if (!token) throw new Error("No Polarion access token available");
    return await runWithPolarionAccessToken(token, () =>
      callGeneratedOperation(
        name,
        args && typeof args === "object" && !Array.isArray(args)
          ? (args as Record<string, unknown>)
          : {},
      ),
    );
  }
}

function stripCodeFences(code: string): string {
  const match = code.match(/^```(?:js|javascript|typescript|ts|tsx|jsx)?\s*\n([\s\S]*?)```\s*$/);
  return match ? match[1] : code;
}

function normalizeCode(code: string): string {
  const trimmed = stripCodeFences(code.trim());
  if (!trimmed.trim()) return "async () => {}";
  const source = trimmed.trim();
  if (/^(async\s*)?\([^)]*\)\s*=>/.test(source) || /^async\s+\(\)\s*=>/.test(source)) {
    return source;
  }
  return `async () => {\n${source}\n}`;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function runCode(code: string, token: string): Promise<unknown> {
  const names = generatedOperationNames();
  const worker = env.LOADER.load({
    compatibilityDate: "2026-08-15",
    mainModule: "worker.js",
    globalOutbound: null,
    env: {
      polarion: exports.PolarionDispatcher({ props: { token } }),
    },
    modules: {
      "worker.js": `
import { WorkerEntrypoint } from "cloudflare:workers";

const toolNames = ${JSON.stringify(names)};

export default class CodeExecutor extends WorkerEntrypoint {
  async evaluate() {
    const dispatcher = this.env.polarion;
    const codemode = Object.fromEntries(
      toolNames.map((name) => [
        name,
        (args) => dispatcher.call(name, args ?? {}),
      ]),
    );
    try {
      const result = await (${normalizeCode(code)})();
      return { result, err: undefined };
    } catch (err) {
      return { result: undefined, err: err.message, stack: err.stack };
    }
  }
}
`,
    },
  });

  const entrypoint = worker.getEntrypoint() as unknown as CodeExecutorEntrypoint;
  const response = await entrypoint.evaluate();
  if (response.err) throw new Error(response.err);
  return response.result;
}

export function registerCodeTool(server: McpServer) {
  server.registerTool(
    "code",
    {
      title: "Polarion code executor",
      description: CODE_TOOL_DESCRIPTION,
      inputSchema: z.object({
        code: z.string().describe("JavaScript async arrow function to execute"),
      }),
      annotations: { title: "Polarion code executor" },
    },
    async ({ code }) => {
      try {
        const token = getPolarionAccessToken();
        if (!token) throw new Error("No Polarion access token available");
        const result = await runCode(code, token);
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
