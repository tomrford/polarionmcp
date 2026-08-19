import { getPolarionAccessToken, runWithPolarionAccessToken } from "./request-context.ts";

export interface RequestContextLike {
  authInfo?: { token?: string };
  requestInfo?: {
    headers?: Record<string, string | string[] | undefined>;
  };
}

export type ResolveAccessToken = (extra: RequestContextLike) => string | undefined;

export async function runWithResolvedAccessToken<T>(
  extra: RequestContextLike,
  resolveAccessToken: ResolveAccessToken,
  fn: () => Promise<T>,
): Promise<T> {
  const token = resolveAccessToken(extra);
  if (!token) throw new Error("No Polarion access token available");
  return await runWithPolarionAccessToken(token, fn);
}

/** Render the bridged Polarion token into an Authorization header for downstream fetches. */
export function authHeaders(_extra: RequestContextLike): { Authorization: string } {
  const token = getPolarionAccessToken();

  if (!token) throw new Error("No Polarion access token available");

  return { Authorization: `Bearer ${token}` };
}

export function errorResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    isError: true,
  };
}

export function ok(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}

export function fieldsParam(resourceType: string, fields?: string) {
  if (!fields) return undefined;
  return { [resourceType]: fields } as Record<string, string>;
}

export function interpolatePath(
  pathTemplate: string,
  pathParams: Record<string, string | number | boolean | undefined>,
) {
  return pathTemplate.replaceAll(/\{([^}]+)\}/g, (_match, rawKey: string) => {
    const value = pathParams[rawKey];

    if (typeof value === "undefined") {
      throw new Error(`Missing required path parameter: ${rawKey}`);
    }

    return encodeURIComponent(String(value));
  });
}

type QueryValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | QueryValue[]
  | { [key: string]: QueryValue };

function appendQueryValue(params: URLSearchParams, key: string, value: QueryValue) {
  if (value === null || typeof value === "undefined") return;

  if (Array.isArray(value)) {
    for (const item of value) appendQueryValue(params, key, item);
    return;
  }

  if (typeof value === "object") {
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      appendQueryValue(params, `${key}[${nestedKey}]`, nestedValue);
    }
    return;
  }

  params.append(key, String(value));
}

export function toQueryString(query: Record<string, QueryValue> | undefined): string {
  if (!query) return "";

  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    appendQueryValue(params, key, value);
  }

  const rendered = params.toString();
  return rendered ? `?${rendered}` : "";
}
