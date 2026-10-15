import { fromJsonSchema, type McpServer } from "@modelcontextprotocol/server";
import { type PolarionConfig, polarionConfig } from "../config";
import { httpError, makeError, networkError } from "../errors";
import { authHeaders, errorResult, interpolatePath, ok, toQueryString } from "../helpers";
import { withToolLogging } from "../logging";
import { GENERATED_OPERATIONS } from "./operations";

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

const DEFAULT_COLLECTION_PAGE_CAP = 100;
const DEFAULT_COLLECTION_ITEM_CAP = 10_000;

function totalCount(payload: { meta?: Record<string, unknown> }) {
  const total = payload.meta?.totalCount;
  return typeof total === "number" && Number.isInteger(total) && total >= 0 ? total : undefined;
}

function collectionPageCap(config: PolarionConfig) {
  return config.collectionPageCap ?? DEFAULT_COLLECTION_PAGE_CAP;
}

function collectionItemCap(config: PolarionConfig) {
  return config.collectionItemCap ?? DEFAULT_COLLECTION_ITEM_CAP;
}

function nextLink(page: { links?: Record<string, unknown> }) {
  const next = page.links?.next;
  return typeof next === "string" && next.length > 0 ? next : undefined;
}

function reachedCollectionCap(pagesFetched: number, itemCount: number, config: PolarionConfig) {
  return pagesFetched >= collectionPageCap(config) || itemCount >= collectionItemCap(config);
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

function resolvePolarionUrl(
  rawUrl: string,
  baseUrl: string,
  polarionBaseUrl: string,
): { url: string } | undefined {
  const polarionUrl = new URL(polarionBaseUrl);
  let resolved: URL;
  try {
    resolved = new URL(rawUrl, baseUrl);
  } catch {
    return undefined;
  }
  if (resolved.origin !== polarionUrl.origin || !isUnderBasePath(resolved, polarionUrl)) {
    return undefined;
  }
  return { url: resolved.toString() };
}

function resolvePageNumberUrl(
  firstPageUrl: string,
  polarionBaseUrl: string,
  pageNumber: number,
): { url: string } | undefined {
  const resolved = resolvePolarionUrl(firstPageUrl, polarionBaseUrl, polarionBaseUrl);
  if (!resolved) return undefined;
  const url = new URL(resolved.url);
  url.searchParams.set("page[number]", String(pageNumber));
  return resolvePolarionUrl(url.toString(), polarionBaseUrl, polarionBaseUrl);
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

function collectionResult(
  operation: (typeof GENERATED_OPERATIONS)[number],
  merged: JsonApiCollection,
  next?: string,
): ToolStructuredResult {
  const payload: Record<string, unknown> = {
    ...stablePayload(operation, merged),
    ...(next ? { incomplete: true, next } : {}),
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

async function readCollectionPage(
  url: string,
  init: RequestInit,
): Promise<JsonApiCollection | undefined> {
  try {
    const response = await fetch(url, init);
    if (!response.ok) return undefined;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) return undefined;
    const payload = normalizeResponseValue(await response.json());
    return isJsonApiCollection(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
}

function plannedPageCount(firstPage: JsonApiCollection) {
  const total = totalCount(firstPage);
  const pageSize = firstPage.data.length;
  if (total === undefined || pageSize < 1 || total <= pageSize) return undefined;
  return Math.ceil(total / pageSize);
}

async function fetchAllPages(
  operation: (typeof GENERATED_OPERATIONS)[number],
  firstPage: JsonApiCollection,
  firstPageUrl: string,
  polarionBaseUrl: string,
  init: RequestInit,
  config: PolarionConfig,
): Promise<ToolResult> {
  const seenIncluded = new Set<string>();
  const seenUrls = new Set<string>([new URL(firstPageUrl).toString()]);
  const merged: JsonApiCollection = {
    ...Object.fromEntries(
      Object.entries(firstPage).filter(
        ([key]) => key !== "data" && key !== "included" && key !== "links" && key !== "meta",
      ),
    ),
    data: [],
  };
  mergeCollectionPage(merged, firstPage, seenIncluded);

  let pendingNext = nextLink(firstPage);
  let pagesFetched = 1;
  const finish = () => collectionResult(operation, merged, pendingNext);
  const absorb = (page: JsonApiCollection) => {
    mergeCollectionPage(merged, page, seenIncluded);
    pagesFetched += 1;
    pendingNext = nextLink(page);
  };

  // totalCount only sizes a parallel page[number] plan. Absence of links.next is what ends the walk.
  const planned = plannedPageCount(firstPage);
  if (planned !== undefined) {
    const lastPlanned = Math.min(planned, collectionPageCap(config));
    let start = 2;
    while (
      start <= lastPlanned &&
      pendingNext &&
      !reachedCollectionCap(pagesFetched, merged.data.length, config)
    ) {
      const end = Math.min(lastPlanned, start + config.fetchConcurrencyCount - 1);
      const jobs: Array<{ pageNumber: number; url: string }> = [];
      for (let pageNumber = start; pageNumber <= end; pageNumber += 1) {
        const resolved = resolvePageNumberUrl(firstPageUrl, polarionBaseUrl, pageNumber);
        if (!resolved || seenUrls.has(resolved.url)) break;
        seenUrls.add(resolved.url);
        jobs.push({ pageNumber, url: resolved.url });
      }
      if (jobs.length === 0 || jobs[0]?.pageNumber !== start) return finish();

      const pages = await Promise.all(
        jobs.map(async (job) => ({
          pageNumber: job.pageNumber,
          page: await readCollectionPage(job.url, init),
        })),
      );
      pages.sort((left, right) => left.pageNumber - right.pageNumber);

      let stoppedEarly = false;
      for (const entry of pages) {
        if (!entry.page) return finish();
        absorb(entry.page);
        if (!pendingNext || reachedCollectionCap(pagesFetched, merged.data.length, config)) {
          stoppedEarly = true;
          break;
        }
      }
      if (stoppedEarly || jobs.length < end - start + 1) break;
      start = end + 1;
    }
  }

  while (pendingNext && !reachedCollectionCap(pagesFetched, merged.data.length, config)) {
    const resolved = resolvePolarionUrl(pendingNext, firstPageUrl, polarionBaseUrl);
    if (!resolved || seenUrls.has(resolved.url)) break;
    seenUrls.add(resolved.url);
    const page = await readCollectionPage(resolved.url, init);
    if (!page) break;
    absorb(page);
  }

  return finish();
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
      isJsonApiCollection(normalizedData) &&
      nextLink(normalizedData)
    ) {
      return await fetchAllPages(operation, normalizedData, url, config.baseUrl, init, config);
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
    const schema: Record<string, unknown> = operation.input.schema;
    server.registerTool(
      operation.name,
      {
        title: operation.name,
        description: `${operation.method} ${operation.pathTemplate}. Returns ${operation.output.summary}.`,
        inputSchema: fromJsonSchema<Record<string, unknown>>(schema),
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
