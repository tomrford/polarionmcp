export interface ErrorResponse {
  error: true;
  status_code: number;
  message: string;
  details?: string;
}

export function makeError(
  statusCode: number,
  message: string,
  details?: string,
): ErrorResponse {
  return { error: true, status_code: statusCode, message, details };
}

export function httpError(status: number, body: unknown): ErrorResponse {
  const details = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  return makeError(status, `HTTP ${status}`, details);
}

export function networkError(err: unknown): ErrorResponse {
  const msg = err instanceof Error ? err.message : String(err);
  return makeError(0, "Network error", msg);
}
