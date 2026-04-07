import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  authHeaders,
  errorResult,
  interpolatePath,
  ok,
  type RequestContextLike,
  toQueryString,
  truncateResponse,
} from "../helpers.ts";
import { makeError, networkError } from "../errors.ts";
import { withToolLogging } from "../logging.ts";
import { getPolarionBaseUrl } from "../client.ts";
import { GENERATED_OPERATIONS } from "./operations.ts";
import { jsonSchemaToZod } from "./schema-to-zod.ts";

const MAX_RESPONSE_CHARS = 16_384;
const DEFAULT_PAGE_SIZE = 20;

function isPlainTextValueWrapper(value: unknown): value is { type: string; value: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return keys.length === 2 &&
    typeof record.type === "string" &&
    record.type.startsWith("text/") &&
    typeof record.value === "string";
}

function normalizeResponseValue(value: unknown, parentKey?: string): unknown {
  if (isPlainTextValueWrapper(value)) return value.value;
  if (Array.isArray(value)) {
    return value.map((item) => normalizeResponseValue(item));
  }
  if (!value || typeof value !== "object") return value;

  const normalized = Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .flatMap(([key, entryValue]) => {
        if (parentKey === "links" && key === "self") return [];

        const nextValue = normalizeResponseValue(entryValue, key);
        if (
          key === "links" && nextValue && typeof nextValue === "object" &&
          !Array.isArray(nextValue) && Object.keys(nextValue).length === 0
        ) {
          return [];
        }

        return [[key, nextValue] as const];
      }),
  );

  return normalized;
}

function extractPageSize(args: Record<string, unknown>, hasPageObject: boolean) {
  if (!hasPageObject) return DEFAULT_PAGE_SIZE;
  const page = args.page;
  if (!page || typeof page !== "object" || Array.isArray(page)) return DEFAULT_PAGE_SIZE;
  const size = (page as Record<string, unknown>).size;
  return typeof size === "number" && Number.isFinite(size) ? size : DEFAULT_PAGE_SIZE;
}

function responsePayloadWithTruncation(
  truncated: ReturnType<typeof truncateResponse>,
): Record<string, unknown> | unknown {
  if (!truncated.truncation) return truncated.data;
  if (truncated.data && typeof truncated.data === "object" && !Array.isArray(truncated.data)) {
    return {
      ...(truncated.data as Record<string, unknown>),
      truncation: truncated.truncation,
    };
  }
  return {
    result: truncated.data,
    truncation: truncated.truncation,
  };
}

function buildQuery(
  args: Record<string, unknown>,
  operation: (typeof GENERATED_OPERATIONS)[number],
) {
  const query: Record<string, unknown> = {};

  for (const [key, wireName] of Object.entries(operation.wire.queryParamMap)) {
    if (key === "page") continue;
    const value = args[key];
    if (typeof value !== "undefined") query[wireName] = value;
  }

  if (operation.wire.pageParamMap) {
    const page = args.page;
    if (page && typeof page === "object" && !Array.isArray(page)) {
      const pageRecord = page as Record<string, unknown>;
      query[operation.wire.pageParamMap.size] = typeof pageRecord.size !== "undefined"
        ? pageRecord.size
        : DEFAULT_PAGE_SIZE;
      query[operation.wire.pageParamMap.number] = typeof pageRecord.number !== "undefined"
        ? pageRecord.number
        : 1;
    } else {
      query[operation.wire.pageParamMap.size] = DEFAULT_PAGE_SIZE;
      query[operation.wire.pageParamMap.number] = 1;
    }
  }

  return query;
}

async function executeOperation(
  operation: (typeof GENERATED_OPERATIONS)[number],
  args: Record<string, unknown>,
  extra: RequestContextLike,
) {
  try {
    const pathParams = Object.fromEntries(
      Object.entries(operation.wire.pathParamMap).map(([key, wireName]) => [wireName, args[key]]),
    );
    const queryString = toQueryString(buildQuery(args, operation) as any);
    const url = `${getPolarionBaseUrl()}${
      interpolatePath(operation.pathTemplate, pathParams)
    }${queryString}`;

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
      return errorResult(
        makeError(response.status, `HTTP ${response.status}`, await response.text()),
      );
    }

    if (operation.output.mode === "no_content" || response.status === 204) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: true }, null, 2) }],
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
    const truncated = truncateResponse(normalizedData, {
      maxItems: extractPageSize(args, operation.input.hasPageObject),
      maxChars: MAX_RESPONSE_CHARS,
    });
    const payload = responsePayloadWithTruncation(truncated);

    return {
      ...ok(payload),
      structuredContent: payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload as Record<string, unknown>
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
        description:
          `${operation.method} ${operation.pathTemplate}. Returns ${operation.output.summary}.`,
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
