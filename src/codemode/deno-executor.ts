import * as acorn from "npm:acorn";
import type { ExecuteResult, Executor, ResolvedProvider } from "npm:@cloudflare/codemode";

const RESERVED_PROVIDER_NAMES = new Set(["__dispatchers", "__logs"]);
const VALID_IDENTIFIER = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;
const DEFAULT_TIMEOUT_MS = 30_000;

function stripCodeFences(code: string): string {
  const match = code.match(/^```(?:js|javascript|typescript|ts|tsx|jsx)?\s*\n([\s\S]*?)```\s*$/);
  return match ? match[1] : code;
}

function normalizeCode(code: string): string {
  const trimmed = stripCodeFences(code.trim());
  if (!trimmed.trim()) return "async () => {}";

  const source = trimmed.trim();

  try {
    const ast = acorn.parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
    });

    if (ast.body.length === 1 && ast.body[0].type === "ExpressionStatement") {
      if (ast.body[0].expression.type === "ArrowFunctionExpression") return source;
    }

    if (ast.body.length === 1 && ast.body[0].type === "ExportDefaultDeclaration") {
      const declaration = ast.body[0].declaration;
      const inner = source.slice(declaration.start, declaration.end);

      if (declaration.type === "FunctionDeclaration" && !declaration.id) {
        return `async () => {\nreturn (${inner})();\n}`;
      }
      if (declaration.type === "ClassDeclaration" && !declaration.id) {
        return `async () => {\nreturn (${inner});\n}`;
      }

      return normalizeCode(inner);
    }

    if (ast.body.length === 1 && ast.body[0].type === "FunctionDeclaration") {
      return `async () => {\n${source}\nreturn ${ast.body[0].id?.name ?? "fn"}();\n}`;
    }

    const last = ast.body[ast.body.length - 1];
    if (last?.type === "ExpressionStatement") {
      return `async () => {\n${source.slice(0, last.start)}return (${
        source.slice(last.expression.start, last.expression.end)
      })\n}`;
    }

    return `async () => {\n${source}\n}`;
  } catch {
    return `async () => {\n${source}\n}`;
  }
}

function sanitizeToolName(name: string): string {
  const reserved = new Set([
    "await",
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "debugger",
    "default",
    "delete",
    "do",
    "else",
    "enum",
    "export",
    "extends",
    "false",
    "finally",
    "for",
    "function",
    "if",
    "import",
    "in",
    "instanceof",
    "new",
    "null",
    "return",
    "super",
    "switch",
    "this",
    "throw",
    "true",
    "try",
    "typeof",
    "var",
    "void",
    "while",
    "with",
    "yield",
  ]);

  let sanitized = name.replace(/[-.\s]/g, "_").replace(/[^a-zA-Z0-9_$]/g, "");
  if (!/^[a-zA-Z_$]/.test(sanitized)) sanitized = `_${sanitized}`;
  if (reserved.has(sanitized)) sanitized = `${sanitized}_`;
  return sanitized;
}

type HostInitMessage = {
  type: "init";
  code: string;
  providers: Array<{ name: string; positionalArgs?: boolean }>;
};

type HostResponseMessage = {
  type: "response";
  id: number;
  result?: unknown;
  error?: string;
};

type HostMessage = HostInitMessage | HostResponseMessage;

type SandboxMessage =
  | {
    type: "call";
    id: number;
    provider: string;
    tool: string;
    args: unknown;
  }
  | {
    type: "log";
    level: "log" | "warn" | "error";
    message: string;
  }
  | {
    type: "result";
    result: unknown;
  }
  | {
    type: "error";
    error: string;
  };

function normalizeProviders(
  providersOrFns:
    | ResolvedProvider[]
    | Record<string, (...args: unknown[]) => Promise<unknown>>,
): ResolvedProvider[] {
  if (Array.isArray(providersOrFns)) return providersOrFns;
  console.warn(
    "[@cloudflare/codemode] Passing raw fns to executor.execute() is deprecated. Use ResolvedProvider[] instead.",
  );
  return [{ name: "codemode", fns: providersOrFns }];
}

function validateProviders(providers: ResolvedProvider[]): string | undefined {
  const seenNames = new Set<string>();

  for (const provider of providers) {
    if (RESERVED_PROVIDER_NAMES.has(provider.name)) {
      return `Provider name "${provider.name}" is reserved`;
    }
    if (!VALID_IDENTIFIER.test(provider.name)) {
      return `Provider name "${provider.name}" is not a valid JavaScript identifier`;
    }
    if (seenNames.has(provider.name)) {
      return `Duplicate provider name "${provider.name}"`;
    }
    seenNames.add(provider.name);
  }

  return undefined;
}

function splitLines(): TransformStream<string, string> {
  let buffer = "";

  return new TransformStream<string, string>({
    transform(chunk, controller) {
      buffer += chunk;

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        controller.enqueue(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
      }
    },
    flush(controller) {
      if (buffer.length > 0) controller.enqueue(buffer);
    },
  });
}

function stringifyMessage(message: HostMessage): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(message)}\n`);
}

function stderrLines(stderr: string): string[] {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `[stderr] ${line}`);
}

export class DenoSubprocessExecutor implements Executor {
  #timeout: number;

  constructor(options: { timeout?: number } = {}) {
    this.#timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  }

  async execute(
    code: string,
    providersOrFns:
      | ResolvedProvider[]
      | Record<string, (...args: unknown[]) => Promise<unknown>>,
  ): Promise<ExecuteResult> {
    const providers = normalizeProviders(providersOrFns);
    const validationError = validateProviders(providers);
    if (validationError) {
      return { result: undefined, error: validationError };
    }

    const dispatchers = new Map(
      providers.map((provider) => [
        provider.name,
        {
          positionalArgs: provider.positionalArgs,
          fns: Object.fromEntries(
            Object.entries(provider.fns).map(([name, fn]) => [sanitizeToolName(name), fn]),
          ),
        },
      ]),
    );

    const workerUrl = new URL("./subprocess-worker.ts", import.meta.url);
    const child = new Deno.Command(Deno.execPath(), {
      args: ["run", "--quiet", workerUrl.pathname],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    const logs: string[] = [];
    let stderrText = "";
    let finalResult: ExecuteResult | undefined;
    let timedOut = false;
    let writeQueue = Promise.resolve();

    const writer = child.stdin.getWriter();
    const queueWrite = (message: HostMessage) => {
      writeQueue = writeQueue.then(async () => {
        try {
          await writer.write(stringifyMessage(message));
        } catch {
          // Child exited; nothing left to write.
        }
      });
      return writeQueue;
    };

    const stdoutTask = (async () => {
      const lines = child.stdout
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(splitLines());

      for await (const line of lines) {
        if (!line.trim()) continue;

        let message: SandboxMessage;
        try {
          message = JSON.parse(line) as SandboxMessage;
        } catch (error) {
          logs.push(`[error] Failed to parse sandbox output: ${String(error)}`);
          continue;
        }

        if (message.type === "log") {
          const prefix = message.level === "warn"
            ? "[warn] "
            : message.level === "error"
            ? "[error] "
            : "";
          logs.push(`${prefix}${message.message}`);
          continue;
        }

        if (message.type === "call") {
          const provider = dispatchers.get(message.provider);
          const tool = provider?.fns[message.tool];

          if (!provider || !tool) {
            await queueWrite({
              type: "response",
              id: message.id,
              error: `Unknown tool: ${message.provider}.${message.tool}`,
            });
            continue;
          }

          void (async () => {
            try {
              const args = provider.positionalArgs
                ? Array.isArray(message.args) ? message.args : []
                : [message.args ?? {}];
              const result = await tool(...args);
              await queueWrite({ type: "response", id: message.id, result });
            } catch (error) {
              await queueWrite({
                type: "response",
                id: message.id,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          })();
          continue;
        }

        if (message.type === "result") {
          finalResult = { result: message.result, logs };
          continue;
        }

        finalResult = { result: undefined, error: message.error, logs };
      }
    })();

    const stderrTask = (async () => {
      const stream = child.stderr.pipeThrough(new TextDecoderStream());
      for await (const chunk of stream) stderrText += chunk;
    })();

    await queueWrite({
      type: "init",
      code: normalizeCode(code),
      providers: providers.map((provider) => ({
        name: provider.name,
        positionalArgs: provider.positionalArgs,
      })),
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // Child may have already exited.
      }
    }, this.#timeout);

    const status = await child.status;
    clearTimeout(timeout);

    await Promise.all([stdoutTask, stderrTask, writeQueue.catch(() => undefined)]);

    try {
      await writer.close();
    } catch {
      // Child already closed stdin.
    }

    if (timedOut) {
      return {
        result: undefined,
        error: "Execution timed out",
        logs: [...logs, ...stderrLines(stderrText)],
      };
    }

    if (finalResult) {
      if (stderrText.trim()) {
        finalResult.logs = [...(finalResult.logs ?? []), ...stderrLines(stderrText)];
      }
      return finalResult;
    }

    return {
      result: undefined,
      error: status.success
        ? "Sandbox exited without returning a result"
        : stderrText.trim() || `Sandbox exited with code ${status.code}`,
      logs: [...logs, ...stderrLines(stderrText)],
    };
  }
}
