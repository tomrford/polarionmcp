export interface ToolLogEvent {
  event: "tool_call";
  tool_name: string;
  outcome: "success" | "error";
  duration_ms: number;
  http_status?: number;
  operation_id?: string;
  policy_mode?: string;
  scope_mode?: string;
  page_size?: number;
  page_number?: number;
  truncated?: boolean;
  has_next?: boolean;
  error_type?: string;
  target_id?: string;
  attribute_count?: number;
}

function safeErrorType(errorLike: unknown): string | undefined {
  if (!errorLike || typeof errorLike !== "object") return undefined;
  if (!("message" in errorLike)) return undefined;
  const message = errorLike.message;
  return typeof message === "string" ? message : undefined;
}

export function logToolEvent(event: ToolLogEvent) {
  console.error(JSON.stringify(event));
}

export function logToolSuccess(
  tool_name: string,
  startedAt: number,
  details: Omit<ToolLogEvent, "event" | "tool_name" | "outcome" | "duration_ms"> = {},
) {
  logToolEvent({
    event: "tool_call",
    tool_name,
    outcome: "success",
    duration_ms: Date.now() - startedAt,
    ...details,
  });
}

export function logToolError(
  tool_name: string,
  startedAt: number,
  details: Omit<ToolLogEvent, "event" | "tool_name" | "outcome" | "duration_ms"> = {},
  errorLike?: unknown,
) {
  logToolEvent({
    event: "tool_call",
    tool_name,
    outcome: "error",
    duration_ms: Date.now() - startedAt,
    error_type: details.error_type ?? safeErrorType(errorLike),
    ...details,
  });
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
  if (!first || typeof first !== "object" || first.type !== "text") {
    return undefined;
  }

  return typeof first.text === "string" ? first.text : undefined;
}

function parseStructuredPayload(result: unknown): Record<string, unknown> | undefined {
  const text = firstContentText(result);
  if (!text) return undefined;

  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object"
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

export function withToolLogging<Args, Result>(
  toolName: string,
  handler: (args: Args, extra: import("./helpers.ts").RequestContextLike) => Promise<Result> | Result,
  details?: (args: Args, result?: Result) => Omit<ToolLogEvent, "event" | "tool_name" | "outcome" | "duration_ms">,
) {
  return async (args: Args, extra: import("./helpers.ts").RequestContextLike) => {
    const startedAt = Date.now();

    try {
      const result = await handler(args, extra);
      const payload = parseStructuredPayload(result);
      const isError =
        !!result &&
        typeof result === "object" &&
        "isError" in result &&
        result.isError === true;

      if (isError) {
        logToolError(
          toolName,
          startedAt,
          {
            ...details?.(args, result),
            http_status:
              typeof payload?.["status_code"] === "number"
                ? payload["status_code"]
                : undefined,
            error_type:
              typeof payload?.["message"] === "string"
                ? payload["message"]
                : undefined,
          },
        );
      } else {
        logToolSuccess(toolName, startedAt, {
          ...details?.(args, result),
          has_next:
            !!payload &&
            typeof payload["pagination"] === "object" &&
            payload["pagination"] !== null &&
            typeof (payload["pagination"] as Record<string, unknown>)["has_next"] === "boolean"
              ? (payload["pagination"] as Record<string, unknown>)["has_next"] as boolean
              : undefined,
          truncated:
            !!payload &&
            typeof payload["truncation"] === "object" &&
            payload["truncation"] !== null,
        });
      }

      return result;
    } catch (error) {
      logToolError(
        toolName,
        startedAt,
        details?.(args),
        error,
      );
      throw error;
    }
  };
}
