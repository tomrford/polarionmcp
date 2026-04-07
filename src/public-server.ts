import type { Executor } from "npm:@cloudflare/codemode";
import { PUBLIC_SERVER_INSTRUCTIONS } from "./instructions.ts";
import { createServer as createInternalToolServer } from "./register.ts";
import { DenoSubprocessExecutor } from "./codemode/deno-executor.ts";
import { createPolarionCodeMcpServer } from "./codemode/polarion-code-mcp-server.ts";

export async function createPublicServer(
  executor: Executor = new DenoSubprocessExecutor(),
) {
  const internalServer = createInternalToolServer();
  return await createPolarionCodeMcpServer({
    server: internalServer,
    executor,
    instructions: PUBLIC_SERVER_INSTRUCTIONS,
  });
}
