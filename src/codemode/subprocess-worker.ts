type HostInitMessage = {
  type: "init";
  code: string;
  providers: Array<{ name: string; positionalArgs?: boolean; tools: string[] }>;
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

const writer = Deno.stdout.writable.getWriter();
const encoder = new TextEncoder();

async function send(message: SandboxMessage) {
  await writer.write(encoder.encode(`${JSON.stringify(message)}\n`));
}

function stringifyArgs(args: unknown[]): string {
  return args.map((value) => String(value)).join(" ");
}

function emitLog(level: "log" | "warn" | "error", args: unknown[]) {
  void send({ type: "log", level, message: stringifyArgs(args) });
}

const stdinLines = Deno.stdin.readable
  .pipeThrough(new TextDecoderStream())
  .pipeThrough(splitLines());
const iterator = stdinLines[Symbol.asyncIterator]();

async function readMessage(): Promise<HostMessage> {
  const next = await iterator.next();
  if (next.done || !next.value) {
    throw new Error("Sandbox stdin closed unexpectedly");
  }
  return JSON.parse(next.value) as HostMessage;
}

const init = await readMessage();
if (init.type !== "init") {
  throw new Error("First sandbox message must be init");
}

const pending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }
>();

void (async () => {
  try {
    while (true) {
      const message = await readMessage();
      if (message.type !== "response") continue;

      const entry = pending.get(message.id);
      if (!entry) continue;
      pending.delete(message.id);

      if (message.error) {
        entry.reject(new Error(message.error));
      } else {
        entry.resolve(message.result);
      }
    }
  } catch {
    for (const entry of pending.values()) {
      entry.reject(new Error("Sandbox host disconnected"));
    }
    pending.clear();
  }
})();

let callId = 0;

function createToolFn(providerName: string, toolName: string, positionalArgs = false) {
  return async (...args: unknown[]) => {
    const id = ++callId;
    const callArgs = positionalArgs ? args : (args[0] ?? {});
    const response = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });

    await send({
      type: "call",
      id,
      provider: providerName,
      tool: toolName,
      args: callArgs,
    });

    return await response;
  };
}

function createProviderProxy(providerName: string, tools: string[], positionalArgs = false) {
  const allowedTools = new Set(tools);
  return new Proxy(
    {},
    {
      get: (_target, toolName) => {
        if (typeof toolName !== "string" || !allowedTools.has(toolName)) return undefined;
        return createToolFn(providerName, toolName, positionalArgs);
      },
    },
  );
}

globalThis.console = {
  log: (...args: unknown[]) => emitLog("log", args),
  info: (...args: unknown[]) => emitLog("log", args),
  debug: (...args: unknown[]) => emitLog("log", args),
  trace: (...args: unknown[]) => emitLog("log", args),
  warn: (...args: unknown[]) => emitLog("warn", args),
  error: (...args: unknown[]) => emitLog("error", args),
  assert: (condition?: boolean, ...args: unknown[]) => {
    if (condition) return;
    const message = args.length > 0 ? ["Assertion failed:", ...args] : ["Assertion failed"];
    emitLog("error", message);
  },
} as typeof console;

try {
  const providerNames = init.providers.map((provider) => provider.name);
  const providerValues = init.providers.map((provider) =>
    createProviderProxy(provider.name, provider.tools, provider.positionalArgs),
  );
  const execute = new Function(...providerNames, `return (${init.code})();`);
  const result = await execute(...providerValues);
  await send({ type: "result", result });
} catch (error) {
  await send({
    type: "error",
    error: error instanceof Error ? error.message : String(error),
  });
} finally {
  await writer.close();
  Deno.exit(0);
}
