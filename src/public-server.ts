import type { Executor } from "npm:@cloudflare/codemode";
import type { RequestContextLike } from "./helpers.ts";
import { PUBLIC_SERVER_INSTRUCTIONS } from "./instructions.ts";
import { createServer as createInternalToolServer } from "./register.ts";
import { DenoSubprocessExecutor } from "./codemode/deno-executor.ts";
import { createPolarionCodeMcpServer } from "./codemode/polarion-code-mcp-server.ts";

export type ResolveAccessToken = (extra: RequestContextLike) => string | undefined;

export async function createPublicServer(options: {
  resolveAccessToken: ResolveAccessToken;
  executor?: Executor;
}) {
  const { resolveAccessToken, executor = new DenoSubprocessExecutor() } = options;
  const internalServer = createInternalToolServer();
  return await createPolarionCodeMcpServer({
    server: internalServer,
    executor,
    instructions: PUBLIC_SERVER_INSTRUCTIONS,
    resolveAccessToken,
  });
}
