import {
  fromJsonSchema,
  type McpServer,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { type PolarionConfig, polarionConfig } from "../config";
import { httpError, isRedirect, makeError, networkError, redirectError } from "../errors";
import { authHeaders, errorResult, interpolatePath, ok, toQueryString } from "../helpers";
import { withToolLogging } from "../logging";
import { GENERATED_OPERATIONS } from "./operations";
import type { GeneratedOperation } from "./types";

type ToolErrorResult = ReturnType<typeof errorResult>;
type ToolStructuredResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
};
type ToolResult = ToolErrorResult | ToolStructuredResult;
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

function structuredResult(payload: Record<string, unknown>): ToolStructuredResult {
  return { ...ok(payload), structuredContent: payload };
}

function jsonApiEnvelope(
  payload: JsonApiCollection | JsonApiResource,
  links: Record<string, unknown> | undefined,
) {
  const extra = extraTopLevelFields(payload);
  return {
    ...(payload.included ? { included: payload.included } : {}),
    ...(links ? { links } : {}),
    ...(payload.meta ? { meta: payload.meta } : {}),
    ...(extra ? { extra } : {}),
  };
}

function stablePayload(operation: GeneratedOperation, payload: unknown): Record<string, unknown> {
  if (operation.output.shape === "collection" && isJsonApiCollection(payload)) {
    return {
      kind: "collection",
      items: payload.data,
      ...jsonApiEnvelope(payload, stripPagingLinks(payload.links)),
    };
  }
  if (operation.output.shape === "resource" && isJsonApiResource(payload)) {
    return { kind: "resource", item: payload.data, ...jsonApiEnvelope(payload, payload.links) };
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
  if (isRedirect(response)) return { error: errorResult(redirectError(response)) };
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

// Fail fast on implausible totals instead of fetching until the request deadline.
const MAX_PAGES = 10_000;

async function fetchAllPages(
  operation: GeneratedOperation,
  firstPage: JsonApiCollection,
  total: number,
  firstPageUrl: string,
  init: RequestInit,
  config: PolarionConfig,
): Promise<ToolResult> {
  // Polarion's default page size applies when REST_PAGE_SIZE is unset; a full first page reveals it.
  const pageSize = config.restPageSize ?? firstPage.data.length;
  if (pageSize === 0) {
    return partialResultError(
      "Polarion pagination returned an empty first page",
      `Cannot plan pagination for ${total} total items from an empty first page.`,
    );
  }
  const totalPages = Math.ceil(total / pageSize);
  if (totalPages > MAX_PAGES) {
    return partialResultError(
      "Polarion pagination exceeded safety limit",
      `More than ${MAX_PAGES} pages are required to fetch the collection.`,
    );
  }
  const seenIncluded = new Set<string>();
  const merged: JsonApiCollection = { ...extraTopLevelFields(firstPage), data: [] };
  mergeCollectionPage(merged, firstPage, seenIncluded);

  for (let start = 2; start <= totalPages; start += config.fetchConcurrencyCount) {
    const end = Math.min(totalPages, start + config.fetchConcurrencyCount - 1);
    const requests: Array<Promise<Awaited<ReturnType<typeof fetchJsonPage>>>> = [];
    for (let pageNumber = start; pageNumber <= end; pageNumber += 1) {
      const pageUrl = new URL(firstPageUrl);
      pageUrl.searchParams.set("page[size]", String(pageSize));
      pageUrl.searchParams.set("page[number]", String(pageNumber));
      requests.push(fetchJsonPage(pageUrl.toString(), init));
    }

    for (const [index, result] of (await Promise.all(requests)).entries()) {
      if ("error" in result) return result.error;
      if (!isJsonApiCollection(result.json)) {
        return partialResultError(
          "Polarion pagination returned a non-collection payload",
          `Expected JSON:API collection while fetching page ${start + index}`,
        );
      }
      mergeCollectionPage(merged, result.json, seenIncluded);
    }
  }

  if (merged.data.length !== total) {
    return partialResultError(
      "Polarion returned a partial collection",
      `Walked ${merged.data.length} items but meta.totalCount reports ${total}.`,
    );
  }

  return structuredResult(stablePayload(operation, merged));
}

function buildQuery(args: Record<string, unknown>, operation: GeneratedOperation) {
  const query: Record<string, unknown> = {};
  for (const name of operation.wire.queryParams) {
    const value = args[name];
    if (typeof value !== "undefined") query[name] = value;
  }
  return query;
}

const OPERATIONS_BY_NAME = new Map<string, GeneratedOperation>(
  GENERATED_OPERATIONS.map((operation) => [operation.name, operation]),
);

type ArgsSchema = StandardSchemaWithJSON<Record<string, unknown>, Record<string, unknown>>;
const argsSchemas = new Map<string, ArgsSchema>();

function argsSchema(operation: GeneratedOperation): ArgsSchema {
  let schema = argsSchemas.get(operation.name);
  if (!schema) {
    schema = fromJsonSchema<Record<string, unknown>>(operation.input.schema);
    argsSchemas.set(operation.name, schema);
  }
  return schema;
}

async function validateArgs(
  operation: GeneratedOperation,
  args: unknown,
): Promise<{ value: Record<string, unknown> } | { error: ToolErrorResult }> {
  const result = await argsSchema(operation)["~standard"].validate(args);
  if (result.issues) {
    return {
      error: errorResult(
        makeError(
          400,
          `Invalid arguments for ${operation.name}`,
          result.issues.map((issue) => issue.message).join("; "),
        ),
      ),
    };
  }
  if (!result.value || typeof result.value !== "object" || Array.isArray(result.value)) {
    return {
      error: errorResult(
        makeError(400, `Invalid arguments for ${operation.name}`, "Arguments must be an object."),
      ),
    };
  }
  return { value: result.value };
}

function buildRequest(
  operation: GeneratedOperation,
  args: Record<string, unknown>,
  config: PolarionConfig,
): { url: string; init: RequestInit } {
  const pathParams = Object.fromEntries(
    operation.wire.pathParams.map((name) => [name, args[name]]),
  ) as Parameters<typeof interpolatePath>[1];
  const queryString = toQueryString(
    buildQuery(args, operation) as Parameters<typeof toQueryString>[0],
  );
  const url = new URL(
    `${config.baseUrl}${interpolatePath(operation.pathTemplate, pathParams)}${queryString}`,
  );
  if (
    operation.method === "GET" &&
    operation.output.collection?.autoPaginate &&
    typeof config.restPageSize === "number"
  ) {
    url.searchParams.set("page[size]", String(config.restPageSize));
  }
  const headers: Record<string, string> = { Accept: "application/json", ...authHeaders() };
  const init: RequestInit = { method: operation.method, headers, redirect: "manual" };
  if (operation.wire.bodyContentType) {
    headers["Content-Type"] = operation.wire.bodyContentType;
    if (typeof args.body !== "undefined") init.body = JSON.stringify(args.body);
  }
  return { url: url.toString(), init };
}

export async function executeGeneratedOperation(
  name: string,
  rawArgs: unknown,
  config: PolarionConfig = polarionConfig(),
): Promise<ToolResult> {
  const operation = OPERATIONS_BY_NAME.get(name);
  if (!operation) return errorResult(makeError(404, `Unknown Polarion operation: ${name}`));
  const validated = await validateArgs(operation, rawArgs);
  if ("error" in validated) return validated.error;
  const args = validated.value;

  let url: string;
  let init: RequestInit;
  try {
    ({ url, init } = buildRequest(operation, args, config));
  } catch (error) {
    return errorResult(makeError(400, error instanceof Error ? error.message : String(error)));
  }

  try {
    const response = await fetch(url, init);
    if (isRedirect(response)) return errorResult(redirectError(response));
    if (!response.ok) return errorResult(httpError(response.status, await response.text()));

    if (operation.output.mode === "no_content" || response.status === 204) {
      return structuredResult(stablePayload(operation, undefined));
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) {
      return errorResult(
        makeError(
          502,
          "Polarion returned a non-JSON response",
          `content-type ${contentType || "(missing)"}`,
        ),
      );
    }

    const normalizedData = normalizeResponseValue(await response.json());
    if (
      operation.method === "GET" &&
      operation.output.collection?.autoPaginate &&
      isJsonApiCollection(normalizedData)
    ) {
      const total = totalCount(normalizedData);
      if (total === undefined) {
        if (normalizedData.links?.next) {
          return partialResultError(
            "Polarion pagination did not return totalCount",
            "The first page links to a next page, but meta.totalCount is missing, so the full collection cannot be verified.",
          );
        }
      } else if (normalizedData.data.length < total) {
        return await fetchAllPages(operation, normalizedData, total, url, init, config);
      } else if (normalizedData.data.length > total) {
        return partialResultError(
          "Polarion returned a partial collection",
          `Response contains ${normalizedData.data.length} items but meta.totalCount reports ${total}.`,
        );
      }
    }

    return structuredResult(stablePayload(operation, normalizedData));
  } catch (error) {
    return errorResult(networkError(error));
  }
}

function loggedOperation(operation: GeneratedOperation) {
  return withToolLogging(
    operation.name,
    (args: unknown) => executeGeneratedOperation(operation.name, args),
    () => ({
      operation_id: operation.name,
      resource_group: operation.resourceGroup,
      method: operation.method,
      path_template: operation.pathTemplate,
    }),
  );
}

// codemode.* entry point: logs like a direct tool call and throws the error payload as text.
export async function callGeneratedOperation(name: string, args: unknown): Promise<unknown> {
  const operation = OPERATIONS_BY_NAME.get(name);
  const result = operation
    ? await loggedOperation(operation)(args)
    : await executeGeneratedOperation(name, args);
  if ("isError" in result) throw new Error(result.content[0].text);
  return result.structuredContent;
}

export function registerGeneratedTools(server: McpServer) {
  for (const operation of GENERATED_OPERATIONS) {
    server.registerTool(
      operation.name,
      {
        title: operation.name,
        description: `${operation.method} ${operation.pathTemplate}. Returns ${operation.output.summary}.`,
        inputSchema: argsSchema(operation),
        annotations: operation.annotations,
        _meta: {
          resourceGroup: operation.resourceGroup,
          inputSummary: operation.meta.inputSummary,
          outputSummary: operation.output.summary,
        },
      },
      loggedOperation(operation),
    );
  }
}
