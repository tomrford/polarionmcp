import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const CUSTOM_INSTRUCTIONS_PATH = "CUSTOM_INSTRUCTIONS.md";

export async function readCustomInstructions(): Promise<string | undefined> {
  try {
    const content = await Deno.readTextFile(CUSTOM_INSTRUCTIONS_PATH);
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

export function appendCustomGuidancePointer(instructions: string): string {
  return `${instructions}\n\n# Custom Guidance\n\nDeployment-specific Polarion requirements guidance is available. Before reading or changing requirements, call \`read_guidelines\` and follow that guidance during all work.`;
}

export function registerGuidelinesTool(server: McpServer, customInstructions: string) {
  server.registerTool(
    "read_guidelines",
    {
      description:
        "Read deployment-specific Polarion requirements guidance from CUSTOM_INSTRUCTIONS.md. Call this before reading or changing requirements.",
      inputSchema: {},
    },
    () => ({
      content: [
        {
          type: "text" as const,
          text: customInstructions,
        },
      ],
    }),
  );
}
