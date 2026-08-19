import type { McpServer } from "@modelcontextprotocol/server";
import { type PolarionConfig, polarionConfig } from "../config";
import { httpError, makeError, networkError } from "../errors";
import { authHeaders, errorResult, interpolatePath, ok, toQueryString } from "../helpers";
import { withToolLogging } from "../logging";
import { GENERATED_OPERATIONS } from "./operations";
import { jsonSchemaToZod } from "./schema-to-zod";

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
type JsonApiCollection = {
  data: unknown[];
  included?: unknown[];
  links?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  [key: string]: unknown;
};
type JsonApiResource = {
  data: Record<string, unknown>;
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
  if (Array.isArray(value)) return value.map((item) => normalizeResponseValue(item));
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

function isJsonApiResource(payload: unknown): payload is JsonApiResource {
  return (
    !!payload &&
    typeof payload === "object" &&
    "data" in payload &&
    !!payload.data &&
    typeof payload.data === "object" &&
    !Array.isArray(payload.data)
  );
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

function extraTopLevelFields(
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const extra = Object.fromEntries(
    Object.entries(payload).filter(
      ([key]) => key !== "data" && key !== "included" && key !== "links" && key !== "meta",
    ),
  );
  return Object.keys(extra).length > 0 ? extra : undefined;
}

function stablePayload(
  operation: (typeof GENERATED_OPERATIONS)[number],
  payload: unknown,
): Record<string, unknown> {
  if (operation.output.shape === "collection" && isJsonApiCollection(payload)) {
    const extra = extraTopLevelFields(payload);
    return {
      kind: "collection",
      items: payload.data,
      ...(payload.included ? { included: payload.included } : {}),
      ...(payload.links ? { links: payload.links } : {}),
      ...(payload.meta ? { meta: payload.meta } : {}),
      ...(extra ? { extra } : {}),
    };
  }

  if (operation.output.shape === "resource" && isJsonApiResource(payload)) {
    const extra = extraTopLevelFields(payload);
    return {
      kind: "resource",
      item: payload.data,
      ...(payload.included ? { included: payload.included } : {}),
      ...(payload.links ? { links: payload.links } : {}),
      ...(payload.meta ? { meta: payload.meta } : {}),
      ...(extra ? { extra } : {}),
    };
  }

  if (operation.output.shape === "ok") return { ok: true };
  return { kind: "json", value: payload };
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

function resolvePageUrl(
  baseUrl: string,
  polarionBaseUrl: string,
  pageNumber: number,
): { error: ToolErrorResult } | { url: string } {
  const polarionUrl = new URL(polarionBaseUrl);
  let resolved: URL;
  try {
    resolved = new URL(baseUrl, polarionUrl);
  } catch {
    return {
      error: partialResultError(
        "Polarion pagination could not resolve the page URL",
        `Could not resolve pagination URL: ${baseUrl}`,
      ),
    };
  }

  if (resolved.origin !== polarionUrl.origin) {
    return {
      error: partialResultError(
        "Polarion pagination resolved a cross-origin page URL",
        `Refusing to fetch pagination URL outside ${polarionUrl.origin}: ${resolved.toString()}`,
      ),
    };
  }

  if (!isUnderBasePath(resolved, polarionUrl)) {
    return {
      error: partialResultError(
        "Polarion pagination resolved a page URL outside the configured base path",
        `Refusing to fetch pagination URL outside ${polarionUrl.pathname}: ${resolved.toString()}`,
      ),
    };
  }

  resolved.searchParams.set("page[number]", String(pageNumber));
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
  if (!response.ok)
    return { error: errorResult(httpError(response.status, await response.text())) };

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

  return { json: normalizeResponseValue(await response.json()) };
}

async function fetchAllPages(
  operation: (typeof GENERATED_OPERATIONS)[number],
  firstPage: JsonApiCollection,
  firstPageUrl: string,
  polarionBaseUrl: string,
  init: RequestInit,
  concurrencyCount: number,
): Promise<ToolResult> {
  const seenIncluded = new Set<string>();
  const total = totalCount(firstPage);
  if (typeof total !== "number") {
    return partialResultError(
      "Polarion pagination did not return totalCount",
      "Auto-paginated collections require meta.totalCount to plan page fetches.",
    );
  }

  const observedPageSize = firstPage.data.length;
  if (total > 0 && observedPageSize === 0) {
    return partialResultError(
      "Polarion pagination returned an empty first page",
      `Cannot plan pagination for ${total} total items from an empty first page.`,
    );
  }

  const totalPages = observedPageSize === 0 ? 1 : Math.ceil(total / observedPageSize);
  if (totalPages > 10_000) {
    return partialResultError(
      "Polarion pagination exceeded safety limit",
      "More than 10000 pages are required to fetch the collection.",
    );
  }

  const merged: JsonApiCollection = {
    ...Object.fromEntries(
      Object.entries(firstPage).filter(
        ([key]) => key !== "data" && key !== "included" && key !== "links" && key !== "meta",
      ),
    ),
    data: [],
  };
  mergeCollectionPage(merged, firstPage, seenIncluded);

  for (let start = 2; start <= totalPages; start += concurrencyCount) {
    const end = Math.min(totalPages, start + concurrencyCount - 1);
    const requests: Array<
      Promise<{ pageNumber: number; result: Awaited<ReturnType<typeof fetchJsonPage>> }>
    > = [];

    for (let pageNumber = start; pageNumber <= end; pageNumber += 1) {
      const pageUrl = resolvePageUrl(firstPageUrl, polarionBaseUrl, pageNumber);
      if ("error" in pageUrl) return pageUrl.error;
      requests.push(fetchJsonPage(pageUrl.url, init).then((result) => ({ pageNumber, result })));
    }

    const pages = await Promise.all(requests);
    pages.sort((a, b) => a.pageNumber - b.pageNumber);

    for (const page of pages) {
      if ("error" in page.result) return page.result.error;
      const payload = page.result.json;
      if (!isJsonApiCollection(payload)) {
        return partialResultError(
          "Polarion pagination returned a non-collection payload",
          `Expected JSON:API collection while fetching page ${page.pageNumber}`,
        );
      }
      mergeCollectionPage(merged, payload, seenIncluded);
    }
  }

  if (merged.data.length !== total) {
    return partialResultError(
      "Polarion returned a partial collection",
      `Walked ${merged.data.length} items but meta.totalCount reports ${total}.`,
    );
  }

  const payload = stablePayload(operation, merged);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
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

function findOperation(name: string) {
  return GENERATED_OPERATIONS.find((operation) => operation.name === name);
}

export async function executeGeneratedOperation(
  name: string,
  args: Record<string, unknown>,
  config: PolarionConfig = polarionConfig(),
): Promise<ToolResult> {
  const operation = findOperation(name);
  if (!operation) return errorResult(makeError(404, `Unknown Polarion operation: ${name}`));

  try {
    const pathParams = Object.fromEntries(
      Object.entries(operation.wire.pathParamMap).map(([key, wireName]) => [wireName, args[key]]),
    );
    const queryString = toQueryString(
      buildQuery(args, operation) as Parameters<typeof toQueryString>[0],
    );
    const baseOperationUrl = `${config.baseUrl}${interpolatePath(
      operation.pathTemplate,
      pathParams,
    )}${queryString}`;
    const operationUrl = new URL(baseOperationUrl);
    if (
      operation.method === "GET" &&
      operation.output.collection?.autoPaginate &&
      typeof config.restPageSize === "number"
    ) {
      operationUrl.searchParams.set("page[size]", String(config.restPageSize));
    }
    const url = operationUrl.toString();
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...authHeaders(),
    };
    const init: RequestInit = { method: operation.method, headers };
    if (operation.wire.bodyContentType) {
      headers["Content-Type"] = operation.wire.bodyContentType;
      if (typeof args.body !== "undefined") init.body = JSON.stringify(args.body);
    }

    const response = await fetch(url, init);
    if (!response.ok) return errorResult(httpError(response.status, await response.text()));

    if (operation.output.mode === "no_content" || response.status === 204) {
      const payload = stablePayload(operation, undefined);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) {
      const text = await response.text();
      return { content: [{ type: "text" as const, text }], structuredContent: { text } };
    }

    const normalizedData = normalizeResponseValue(await response.json());
    if (
      operation.method === "GET" &&
      operation.output.collection?.autoPaginate &&
      isJsonApiCollection(normalizedData)
    ) {
      const total = totalCount(normalizedData);
      if (typeof total === "number") {
        if (normalizedData.data.length < total) {
          return await fetchAllPages(
            operation,
            normalizedData,
            url,
            config.baseUrl,
            init,
            config.fetchConcurrencyCount,
          );
        }
        if (normalizedData.data.length > total) {
          return partialResultError(
            "Polarion returned a partial collection",
            `Response contains ${normalizedData.data.length} items but meta.totalCount reports ${total}.`,
          );
        }
      }
    }

    const payload = stablePayload(operation, normalizedData);
    return { ...ok(payload), structuredContent: payload };
  } catch (error) {
    return errorResult(networkError(error));
  }
}

export async function callGeneratedOperation(
  name: string,
  args: Record<string, unknown>,
  config: PolarionConfig = polarionConfig(),
): Promise<unknown> {
  const result = await executeGeneratedOperation(name, args, config);
  if ("isError" in result && result.isError) {
    const text = result.content[0]?.text ?? "Tool call failed";
    throw new Error(text);
  }
  if ("structuredContent" in result) return result.structuredContent;
  return result.content[0]?.text;
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
        async (args) =>
          await executeGeneratedOperation(operation.name, args as Record<string, unknown>),
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
