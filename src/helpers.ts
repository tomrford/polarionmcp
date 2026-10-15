import { getPolarionAccessToken } from "./request-context";

export function authHeaders(): { Authorization: string } {
  const token = getPolarionAccessToken();
  if (!token) throw new Error("No Polarion access token available");
  return { Authorization: `Bearer ${token}` };
}

export function errorResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    isError: true as const,
  };
}

export function ok(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}

export function unsafePathSegment(value: string): string | undefined {
  if (value.length === 0) return "empty";
  if (value === "." || value === "..") return value;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return "malformed percent-encoding";
  }
  if (decoded.length === 0) return "empty";
  if (decoded === "." || decoded === "..") return decoded;
  return undefined;
}

export function encodePathSegment(value: string | number | boolean): string {
  const text = String(value);
  const reason = unsafePathSegment(text);
  if (reason === "empty") throw new Error("Invalid path segment: empty");
  if (reason) throw new Error(`Invalid path segment: ${text}`);
  return encodeURIComponent(text);
}

export function assertUrlUnderBase(url: URL, baseUrl: string): void {
  const base = new URL(baseUrl);
  const prefix =
    base.pathname === "/"
      ? ""
      : base.pathname.endsWith("/")
        ? base.pathname.slice(0, -1)
        : base.pathname;
  const under =
    url.origin === base.origin &&
    (prefix === "" || url.pathname === prefix || url.pathname.startsWith(`${prefix}/`));
  if (!under) {
    throw new Error(`Refusing Polarion URL outside ${base.origin}${prefix || "/"}`);
  }
  if (
    url.pathname
      .split("/")
      .slice(1)
      .some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error("Refusing Polarion URL with an empty or dot path segment");
  }
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
    return encodePathSegment(value);
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
