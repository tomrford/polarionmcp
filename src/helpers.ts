export interface PaginationMeta {
  total: number | undefined;
  page_size: number;
  page_number: number;
  has_next: boolean;
}

export interface RequestContextLike {
  authInfo?: { token?: string };
  requestInfo?: {
    headers?: Record<string, string | string[] | undefined>;
  };
}

export interface TruncationOptions {
  maxItems: number;
  maxChars: number;
}

export interface TruncationMeta {
  reason: "item_limit" | "char_limit";
  original_item_count?: number;
  returned_item_count?: number;
  max_items: number;
  max_chars: number;
  hint: string;
}

export interface TruncatedResponse {
  data: unknown;
  truncation?: TruncationMeta;
}

export function pagination(
  totalCount: number | undefined,
  pageSize: number,
  pageNumber: number,
  nextLink: string | undefined,
): PaginationMeta {
  return {
    total: totalCount,
    page_size: pageSize,
    page_number: pageNumber,
    has_next: !!nextLink,
  };
}

/** Extract a Bearer token from MCP request context, falling back to env var for stdio mode. */
export function authHeaders(extra: RequestContextLike): { Authorization: string } {
  const rawHeader = extra.requestInfo?.headers?.["authorization"];
  const headerToken =
    typeof rawHeader === "string"
      ? rawHeader.replace(/^Bearer\s+/i, "")
      : undefined;
  const token =
    extra.authInfo?.token ??
    headerToken ??
    Deno.env.get("POLARION_ACCESS_TOKEN");

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
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
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

function appendQueryValue(
  params: URLSearchParams,
  key: string,
  value: QueryValue,
) {
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

export function toQueryString(
  query: Record<string, QueryValue> | undefined,
): string {
  if (!query) return "";

  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    appendQueryValue(params, key, value);
  }

  const rendered = params.toString();
  return rendered ? `?${rendered}` : "";
}

function sliceJsonApiCollection(rawData: unknown, maxItems: number): {
  data: unknown;
  originalItemCount?: number;
  returnedItemCount?: number;
} {
  if (
    !rawData ||
    typeof rawData !== "object" ||
    !("data" in rawData) ||
    !Array.isArray(rawData.data)
  ) {
    return { data: rawData };
  }

  const originalItemCount = rawData.data.length;
  if (originalItemCount <= maxItems) {
    return { data: rawData, originalItemCount, returnedItemCount: originalItemCount };
  }

  return {
    data: { ...rawData, data: rawData.data.slice(0, maxItems) },
    originalItemCount,
    returnedItemCount: maxItems,
  };
}

export function truncateResponse(
  rawData: unknown,
  options: TruncationOptions,
): TruncatedResponse {
  const initial = sliceJsonApiCollection(rawData, options.maxItems);
  let data = initial.data;

  if (
    typeof initial.originalItemCount === "number" &&
    typeof initial.returnedItemCount === "number" &&
    initial.originalItemCount > initial.returnedItemCount
  ) {
    return {
      data,
      truncation: {
        reason: "item_limit",
        original_item_count: initial.originalItemCount,
        returned_item_count: initial.returnedItemCount,
        max_items: options.maxItems,
        max_chars: options.maxChars,
        hint: "Use page_number and page_size to fetch the next slice.",
      },
    };
  }

  let rendered = JSON.stringify(data);
  if (rendered.length <= options.maxChars) {
    return { data };
  }

  if (
    data &&
    typeof data === "object" &&
    "data" in data &&
    Array.isArray(data.data)
  ) {
    let items = data.data.slice();
    while (items.length > 1) {
      items = items.slice(0, Math.max(1, Math.floor(items.length / 2)));
      const candidate = { ...data, data: items };
      rendered = JSON.stringify(candidate);
      if (rendered.length <= options.maxChars) {
        return {
          data: candidate,
          truncation: {
            reason: "char_limit",
            original_item_count: data.data.length,
            returned_item_count: items.length,
            max_items: options.maxItems,
            max_chars: options.maxChars,
            hint: "Use fields or narrower filters to reduce payload size.",
          },
        };
      }
    }
  }

  return {
    data: {
      truncated_preview: rendered.slice(0, options.maxChars) + "…(truncated)",
    },
    truncation: {
      reason: "char_limit",
      max_items: options.maxItems,
      max_chars: options.maxChars,
      hint: "Use fields or narrower filters to reduce payload size.",
    },
  };
}
