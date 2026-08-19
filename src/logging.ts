export interface ToolLogEvent {
  event: "tool_call";
  tool_name: string;
  outcome: "success" | "error";
  duration_ms: number;
  http_status?: number;
  operation_id?: string;
  error_type?: string;
  target_id?: string;
  resource_group?: string;
  method?: string;
  path_template?: string;
}

function safeErrorType(errorLike: unknown): string | undefined {
  if (!errorLike || typeof errorLike !== "object" || !("message" in errorLike)) return undefined;
  return typeof errorLike.message === "string" ? errorLike.message : undefined;
}

export function logToolEvent(event: ToolLogEvent) {
  console.error(JSON.stringify(event));
}

function firstContentText(result: unknown): string | undefined {
  if (
    !result ||
    typeof result !== "object" ||
    !("content" in result) ||
    !Array.isArray(result.content) ||
    result.content.length === 0
  ) {
    return undefined;
  }
  const first = result.content[0];
  if (!first || typeof first !== "object" || first.type !== "text") return undefined;
  return typeof first.text === "string" ? first.text : undefined;
}

function parseStructuredPayload(result: unknown): Record<string, unknown> | undefined {
  const text = firstContentText(result);
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function withToolLogging<Args, Result>(
  toolName: string,
  handler: (args: Args) => Promise<Result> | Result,
  details?: (
    args: Args,
    result?: Result,
  ) => Omit<ToolLogEvent, "event" | "tool_name" | "outcome" | "duration_ms">,
) {
  return async (args: Args) => {
    const startedAt = Date.now();
    try {
      const result = await handler(args);
      const payload = parseStructuredPayload(result);
      const isError =
        !!result && typeof result === "object" && "isError" in result && result.isError === true;
      logToolEvent({
        event: "tool_call",
        tool_name: toolName,
        outcome: isError ? "error" : "success",
        duration_ms: Date.now() - startedAt,
        ...details?.(args, result),
        ...(isError
          ? {
              http_status:
                typeof payload?.status_code === "number" ? payload.status_code : undefined,
              error_type: typeof payload?.message === "string" ? payload.message : undefined,
            }
          : {}),
      });
      return result;
    } catch (error) {
      logToolEvent({
        event: "tool_call",
        tool_name: toolName,
        outcome: "error",
        duration_ms: Date.now() - startedAt,
        error_type: safeErrorType(error),
        ...details?.(args),
      });
      throw error;
    }
  };
}
