export interface ErrorResponse {
  error: true;
  status_code: number;
  message: string;
  details?: string;
  suggestion?: string;
}

export function makeError(
  statusCode: number,
  message: string,
  details?: string,
  suggestion?: string,
): ErrorResponse {
  return {
    error: true,
    status_code: statusCode,
    message,
    ...(typeof details === "undefined" ? {} : { details }),
    ...(typeof suggestion === "undefined" ? {} : { suggestion }),
  };
}

function httpSuggestion(status: number): string | undefined {
  if (status === 403) return "Access denied. User action required.";
  if (status === 404) return "Not found at this path.";
  return undefined;
}

export function httpError(status: number, body: unknown): ErrorResponse {
  const details = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  return makeError(status, `HTTP ${status}`, details, httpSuggestion(status));
}

export function networkError(err: unknown): ErrorResponse {
  const msg = err instanceof Error ? err.message : String(err);
  return makeError(0, "Network error", msg);
}
