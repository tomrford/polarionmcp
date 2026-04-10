import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  authHeaders,
  errorResult,
  interpolatePath,
  ok,
  type RequestContextLike,
  toQueryString,
} from "../helpers.ts";
import { httpError, makeError, networkError } from "../errors.ts";
import { withToolLogging } from "../logging.ts";
import { getPolarionBaseUrl } from "../client.ts";
import { GENERATED_OPERATIONS } from "./operations.ts";
import { jsonSchemaToZod } from "./schema-to-zod.ts";

type ToolErrorResult = ReturnType<typeof errorResult>;
type ToolStructuredResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
};
type ToolTextResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
};
type ToolResult = ToolErrorResult | ToolStructuredResult | ToolTextResult;
type ResolvedNextPageUrl = { error: ToolErrorResult } | { url: string };
type JsonApiCollection = {
  data: unknown[];
  included?: unknown[];
  links?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  [key: string]: unknown;
};

function isPlainTextValueWrapper(value: unknown): value is { type: string; value: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return (
    keys.length === 2 &&
    typeof record.type === "string" &&
    record.type.startsWith("text/") &&
    typeof record.value === "string"
  );
}

function normalizeResponseValue(value: unknown, parentKey?: string): unknown {
  if (isPlainTextValueWrapper(value)) return value.value;
  if (Array.isArray(value)) {
    return value.map((item) => normalizeResponseValue(item));
  }
  if (!value || typeof value !== "object") return value;

  const normalized = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, entryValue]) => {
      if (parentKey === "links" && key === "self") return [];

      const nextValue = normalizeResponseValue(entryValue, key);
      if (
        key === "links" &&
        nextValue &&
        typeof nextValue === "object" &&
        !Array.isArray(nextValue) &&
        Object.keys(nextValue).length === 0
      ) {
        return [];
      }

      return [[key, nextValue] as const];
    }),
  );

  return normalized;
}

function isJsonApiCollection(payload: unknown): payload is JsonApiCollection {
  return (
    !!payload && typeof payload === "object" && "data" in payload && Array.isArray(payload.data)
  );
}

function nextPageLink(payload: { links?: Record<string, unknown> }) {
  const next = payload.links?.next;
  return typeof next === "string" && next.length > 0 ? next : undefined;
}

function totalCount(payload: { meta?: Record<string, unknown> }) {
  const total = payload.meta?.totalCount;
  return typeof total === "number" && Number.isFinite(total) ? total : undefined;
}

function partialResultError(message: string, details: string) {
  return errorResult(makeError(409, message, details));
}

function stripPagingLinks(links: Record<string, unknown> | undefined) {
  if (!links) return undefined;
  const filtered = Object.fromEntries(
    Object.entries(links).filter(
      ([key]) => key !== "first" && key !== "last" && key !== "next" && key !== "prev",
    ),
  );
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

function includedIdentity(entry: unknown) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const record = entry as Record<string, unknown>;
  return typeof record.type === "string" && typeof record.id === "string"
    ? `${record.type}:${record.id}`
    : undefined;
}

function isUnderBasePath(candidate: URL, base: URL) {
  const basePath =
    base.pathname.endsWith("/") && base.pathname !== "/"
      ? base.pathname.slice(0, -1)
      : base.pathname;
  if (basePath === "/") return true;
  return candidate.pathname === basePath || candidate.pathname.startsWith(`${basePath}/`);
}

function resolveNextPageUrl(nextLink: string): ResolvedNextPageUrl {
  const polarionUrl = new URL(getPolarionBaseUrl());
  let resolved: URL;
  try {
    resolved = new URL(nextLink, polarionUrl);
  } catch {
    return {
      error: partialResultError(
        "Polarion pagination returned an invalid next link",
        `Could not resolve pagination link: ${nextLink}`,
      ),
    };
  }

  if (resolved.origin !== polarionUrl.origin) {
    return {
      error: partialResultError(
        "Polarion pagination returned a cross-origin next link",
        `Refusing to follow pagination link outside ${polarionUrl.origin}: ${resolved.toString()}`,
      ),
    };
  }

  if (!isUnderBasePath(resolved, polarionUrl)) {
    return {
      error: partialResultError(
        "Polarion pagination returned a next link outside the configured base path",
        `Refusing to follow pagination link outside ${polarionUrl.pathname}: ${resolved.toString()}`,
      ),
    };
  }

  return { url: resolved.toString() };
}

function mergeCollectionPage(
  acc: JsonApiCollection,
  page: JsonApiCollection,
  seenIncluded: Set<string>,
) {
  acc.data.push(...page.data);

  if (Array.isArray(page.included) && page.included.length > 0) {
    acc.included ??= [];
    for (const entry of page.included) {
      const identity = includedIdentity(entry);
      if (!identity || !seenIncluded.has(identity)) {
        acc.included.push(entry);
        if (identity) seenIncluded.add(identity);
      }
    }
  }

  if (page.meta && typeof page.meta === "object") {
    acc.meta = { ...acc.meta, ...page.meta };
  }

  const links = stripPagingLinks(page.links);
  if (links) acc.links = { ...acc.links, ...links };
}

async function fetchJsonPage(
  url: string,
  init: RequestInit,
): Promise<{ error: ToolErrorResult } | { json: unknown }> {
  const response = await fetch(url, init);
  if (!response.ok) {
    return {
      error: errorResult(httpError(response.status, await response.text())),
    };
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    return {
      error: partialResultError(
        "Polarion pagination returned non-JSON content",
        `Expected JSON while following ${url}; received content-type ${
          contentType || "(missing)"
        }.`,
      ),
    };
  }

  return {
    json: normalizeResponseValue(await response.json()),
  };
}

async function fetchAllPages(firstPage: JsonApiCollection, init: RequestInit): Promise<ToolResult> {
  const visited = new Set<string>();
  const seenIncluded = new Set<string>();
  let currentPage: JsonApiCollection | undefined = firstPage;
  const firstNext = nextPageLink(firstPage);
  let currentUrl: string | undefined;
  if (firstNext) {
    const initialPageUrl = resolveNextPageUrl(firstNext);
    if ("error" in initialPageUrl) return initialPageUrl.error;
    currentUrl = initialPageUrl.url;
  }
  let pageCount = 1;
  const merged: JsonApiCollection = {
    ...Object.fromEntries(
      Object.entries(firstPage).filter(
        ([key]) => key !== "data" && key !== "included" && key !== "links" && key !== "meta",
      ),
    ),
    data: [],
  };

  while (currentPage) {
    mergeCollectionPage(merged, currentPage, seenIncluded);
    if (!currentUrl) break;

    if (visited.has(currentUrl)) {
      return partialResultError(
        "Polarion pagination loop detected",
        `Repeated next link while walking pages: ${currentUrl}`,
      );
    }
    visited.add(currentUrl);
    pageCount += 1;
    if (pageCount > 10_000) {
      return partialResultError(
        "Polarion pagination exceeded safety limit",
        "More than 10000 pages were returned while walking the collection.",
      );
    }

    const pageResult = await fetchJsonPage(currentUrl, init);
    if ("error" in pageResult) return pageResult.error;

    const payload = pageResult.json;
    if (!isJsonApiCollection(payload)) {
      return partialResultError(
        "Polarion pagination returned a non-collection payload",
        `Expected JSON:API collection while following ${currentUrl}`,
      );
    }

    currentPage = payload;
    const next = nextPageLink(currentPage);
    if (!next) {
      currentUrl = undefined;
      continue;
    }
    const nextPageUrl = resolveNextPageUrl(next);
    if ("error" in nextPageUrl) return nextPageUrl.error;
    currentUrl = nextPageUrl.url;
  }

  const total = totalCount(merged);
  if (typeof total === "number" && merged.data.length !== total) {
    return partialResultError(
      "Polarion returned a partial collection",
      `Walked ${merged.data.length} items but meta.totalCount reports ${total}.`,
    );
  }

  return {
    content: [{ type: "text" as const, text: JSON.stringify(merged) }],
    structuredContent: merged,
  };
}

function buildQuery(
  args: Record<string, unknown>,
  operation: (typeof GENERATED_OPERATIONS)[number],
) {
  const query: Record<string, unknown> = {};

  for (const [key, wireName] of Object.entries(operation.wire.queryParamMap)) {
    const value = args[key];
    if (typeof value !== "undefined") query[wireName] = value;
  }

  return query;
}

async function executeOperation(
  operation: (typeof GENERATED_OPERATIONS)[number],
  args: Record<string, unknown>,
  extra: RequestContextLike,
): Promise<ToolResult> {
  try {
    const pathParams = Object.fromEntries(
      Object.entries(operation.wire.pathParamMap).map(([key, wireName]) => [wireName, args[key]]),
    );
    const queryString = toQueryString(buildQuery(args, operation) as any);
    const url = `${getPolarionBaseUrl()}${interpolatePath(
      operation.pathTemplate,
      pathParams,
    )}${queryString}`;

    const headers: Record<string, string> = {
      Accept: "application/json",
      ...authHeaders(extra),
    };

    const init: RequestInit = {
      method: operation.method,
      headers,
    };

    if (operation.wire.bodyContentType) {
      headers["Content-Type"] = operation.wire.bodyContentType;
      if (typeof args.body !== "undefined") {
        init.body = JSON.stringify(args.body);
      }
    }

    const response = await fetch(url, init);
    if (!response.ok) {
      return errorResult(httpError(response.status, await response.text()));
    }

    if (operation.output.mode === "no_content" || response.status === 204) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }],
        structuredContent: { ok: true },
      };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) {
      const text = await response.text();
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: { text },
      };
    }

    const rawData = await response.json();
    const normalizedData = normalizeResponseValue(rawData);

    if (
      operation.method === "GET" &&
      operation.output.collection?.autoPaginate &&
      isJsonApiCollection(normalizedData)
    ) {
      const next = nextPageLink(normalizedData);
      const total = totalCount(normalizedData);
      if (next) {
        return await fetchAllPages(normalizedData, init);
      }
      if (typeof total === "number" && normalizedData.data.length < total) {
        return partialResultError(
          "Polarion returned a partial collection",
          `Response contains ${normalizedData.data.length} items but meta.totalCount reports ${total}.`,
        );
      }
    }

    const payload = normalizedData;

    return {
      ...ok(payload),
      structuredContent:
        payload && typeof payload === "object" && !Array.isArray(payload)
          ? (payload as Record<string, unknown>)
          : { result: payload },
    };
  } catch (error) {
    return errorResult(networkError(error));
  }
}

export function registerGeneratedTools(server: McpServer) {
  for (const operation of GENERATED_OPERATIONS) {
    server.registerTool(
      operation.name,
      {
        title: operation.name,
        description: `${operation.method} ${operation.pathTemplate}. Returns ${operation.output.summary}.`,
        inputSchema: jsonSchemaToZod(operation.input.schema),
        annotations: operation.annotations,
        _meta: {
          resourceGroup: operation.resourceGroup,
          inputSummary: operation.meta.inputSummary,
          outputSummary: operation.output.summary,
        },
      },
      withToolLogging(
        operation.name,
        async (args, extra) =>
          await executeOperation(
            operation,
            args as Record<string, unknown>,
            extra as RequestContextLike,
          ),
        () => ({
          operation_id: operation.name,
          resource_group: operation.resourceGroup,
          method: operation.method,
          path_template: operation.pathTemplate,
        }),
      ),
    );
  }
}
