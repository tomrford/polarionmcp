import { ALLOWED_OPERATION_IDS } from "../src/openapi/allowed-operations.ts";

type HttpMethod = "get" | "post" | "patch" | "delete";

type OpenApiSchema = {
  $ref?: string;
  type?: string;
  format?: string;
  description?: string;
  enum?: unknown[];
  const?: unknown;
  nullable?: boolean;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  items?: OpenApiSchema;
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
  additionalProperties?: boolean | OpenApiSchema;
  oneOf?: OpenApiSchema[];
  anyOf?: OpenApiSchema[];
  allOf?: OpenApiSchema[];
};

type OpenApiParameter = {
  $ref?: string;
  name?: string;
  in?: "query" | "path" | "header" | "cookie" | string;
  required?: boolean;
  description?: string;
  schema?: OpenApiSchema;
};

type OpenApiRequestBody = {
  required?: boolean;
  description?: string;
  content?: Record<string, { schema?: OpenApiSchema }>;
};

type OpenApiResponse = {
  description?: string;
  content?: Record<string, { schema?: OpenApiSchema }>;
};

type OpenApiOperation = {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
  responses?: Record<string, OpenApiResponse>;
};

type OpenApiPathItem = {
  parameters?: OpenApiParameter[];
  get?: OpenApiOperation;
  post?: OpenApiOperation;
  patch?: OpenApiOperation;
  delete?: OpenApiOperation;
};

type OpenApiSpec = {
  openapi: string;
  info: Record<string, unknown>;
  servers?: unknown[];
  tags?: unknown[];
  components?: Record<string, unknown>;
  paths: Record<string, OpenApiPathItem>;
};

type GeneratedOperation = {
  name: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  pathTemplate: string;
  description: string;
  resourceGroup: string;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  input: {
    required: string[];
    schema: Record<string, unknown>;
    pathParams: string[];
    queryParams: string[];
    hasBody: boolean;
  };
  wire: {
    pathParamMap: Record<string, string>;
    queryParamMap: Record<string, string>;
    bodyContentType?: "application/json";
  };
  output: {
    mode: "json" | "no_content";
    summary: string;
    collection?: {
      autoPaginate: true;
    };
  };
};

const ROOT_SPEC_PATH = "polarionrest.json";
const TRIMMED_SPEC_PATH = "generated/polarion.trimmed.json";
const GENERATED_TYPES_PATH = "generated/polarion.ts";
const GENERATED_OPERATIONS_PATH = "src/generated/operations.ts";
const ALLOWLIST_DOC_PATH = "docs/allowlist.md";
const METHOD_ORDER: HttpMethod[] = ["get", "post", "patch", "delete"];
function resolveRefs(obj: unknown, root: unknown, seen = new Set<string>()): unknown {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map((item) => resolveRefs(item, root, seen));

  const record = obj as Record<string, unknown>;
  if (typeof record.$ref === "string") {
    const ref = record.$ref;
    if (seen.has(ref)) return { $circular: ref };
    if (!ref.startsWith("#/")) return record;

    seen.add(ref);
    const parts = ref
      .slice(2)
      .split("/")
      .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));

    let resolved = root as Record<string, unknown> | undefined;
    for (const part of parts) {
      if (!resolved || typeof resolved !== "object") break;
      resolved = resolved[part] as Record<string, unknown> | undefined;
    }

    const result = resolveRefs(resolved, root, seen);
    seen.delete(ref);
    return result;
  }

  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, resolveRefs(value, root, seen)]),
  );
}

function resourceGroupForPath(pathTemplate: string) {
  if (pathTemplate.includes("/workitems")) return "workitems";
  if (pathTemplate.includes("/documents")) return "documents";
  if (
    pathTemplate.includes("/testruns") ||
    pathTemplate.includes("/testrecords") ||
    pathTemplate.includes("/teststepresults")
  ) {
    return "testruns";
  }
  if (pathTemplate.includes("/plans")) return "plans";
  if (
    pathTemplate.includes("getFieldsMetadata") ||
    pathTemplate.includes("/customfields") ||
    pathTemplate.includes("/enumerations") ||
    pathTemplate === "/metadata"
  ) {
    return "metadata";
  }
  if (pathTemplate.startsWith("/jobs")) return "jobs";
  if (pathTemplate.startsWith("/projects") || pathTemplate === "/projecttemplates") {
    return "projects";
  }
  return "misc";
}

function annotationsForMethod(method: GeneratedOperation["method"]) {
  switch (method) {
    case "GET":
      return {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      };
    case "DELETE":
      return {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      };
    default:
      return {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      };
  }
}

function sanitizeSchema(schema: OpenApiSchema | undefined): Record<string, unknown> {
  if (!schema || typeof schema !== "object") return {};

  if ("$circular" in schema) return {};

  const out: Record<string, unknown> = {};
  for (const key of [
    "type",
    "format",
    "description",
    "enum",
    "const",
    "nullable",
    "minimum",
    "maximum",
    "minLength",
    "maxLength",
  ]) {
    if (key in schema && typeof schema[key as keyof OpenApiSchema] !== "undefined") {
      out[key] = schema[key as keyof OpenApiSchema];
    }
  }

  if (schema.items) out.items = sanitizeSchema(schema.items);
  if (schema.properties) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [key, sanitizeSchema(value)]),
    );
  }
  if (schema.required?.length) out.required = [...schema.required];

  if (typeof schema.additionalProperties === "boolean") {
    out.additionalProperties = schema.additionalProperties;
  } else if (schema.additionalProperties) {
    out.additionalProperties = sanitizeSchema(schema.additionalProperties);
  }

  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    if (schema[key]?.length) out[key] = schema[key].map((item) => sanitizeSchema(item));
  }

  if (
    !("type" in out) &&
    !("enum" in out) &&
    !("oneOf" in out) &&
    !("anyOf" in out) &&
    !("allOf" in out) &&
    !("properties" in out) &&
    !("items" in out)
  ) {
    return {};
  }

  return out;
}

function withDescription(
  schema: Record<string, unknown>,
  description: string | undefined,
): Record<string, unknown> {
  if (!description || schema.description) return schema;
  return { ...schema, description };
}

function bodyInputSchema(
  schema: OpenApiSchema | undefined,
  description: string | undefined,
): Record<string, unknown> {
  if (!schema || typeof schema !== "object") {
    return {
      type: "object",
      additionalProperties: true,
      ...(description ? { description } : {}),
    };
  }

  const type = schema.type;
  if (
    type === "string" ||
    type === "number" ||
    type === "integer" ||
    type === "boolean" ||
    type === "array"
  ) {
    return withDescription(sanitizeSchema(schema), description);
  }

  return {
    type: "object",
    additionalProperties: true,
    ...((description ?? schema.description)
      ? { description: description ?? schema.description }
      : {}),
  };
}

function pickSuccessResponse(
  responses: Record<string, OpenApiResponse> | undefined,
): [string, OpenApiResponse] | undefined {
  if (!responses) return undefined;
  for (const status of ["200", "201", "202", "204"]) {
    if (responses[status]) return [status, responses[status]];
  }
  const first = Object.entries(responses).find(([status]) => status.startsWith("2"));
  return first;
}

function refName(schema: OpenApiSchema | undefined): string | undefined {
  if (!schema?.$ref) return undefined;
  return schema.$ref.split("/").at(-1);
}

function topLevelKeys(schema: OpenApiSchema | undefined): string[] {
  const properties = schema?.properties;
  if (!properties || typeof properties !== "object") return [];
  return Object.keys(properties).slice(0, 4);
}

function buildOutputSummary(
  rawOperation: OpenApiOperation,
  resolvedOperation: OpenApiOperation,
): GeneratedOperation["output"] {
  const rawSuccess = pickSuccessResponse(rawOperation.responses);
  const resolvedSuccess = pickSuccessResponse(resolvedOperation.responses);
  if (!rawSuccess || !resolvedSuccess) {
    return { mode: "json", summary: "JSON response" };
  }

  const [status, rawResponse] = rawSuccess;
  const [, resolvedResponse] = resolvedSuccess;
  if (status === "204") return { mode: "no_content", summary: "{ ok: true }" };

  const rawSchema = rawResponse.content?.["application/json"]?.schema;
  const resolvedSchema = resolvedResponse.content?.["application/json"]?.schema;
  const name = refName(rawSchema);
  const keys = topLevelKeys(resolvedSchema);
  if (name && keys.length > 0) return { mode: "json", summary: `${name} (${keys.join("/")})` };
  if (name) return { mode: "json", summary: name };
  if (keys.length > 0) return { mode: "json", summary: `object (${keys.join("/")})` };
  return { mode: "json", summary: `${status} JSON response` };
}

function summarizeInput(required: string[], properties: string[], hasBody: boolean) {
  const optional = properties.filter((name) => !required.includes(name));
  const parts: string[] = [];
  if (required.length > 0) parts.push(`required: ${required.join(", ")}`);
  if (optional.length > 0) parts.push(`optional: ${optional.join(", ")}`);
  if (hasBody && !properties.includes("body")) parts.push("includes body");
  return parts.join("; ") || "no parameters";
}

function assertJsonRequestBody(operationId: string, requestBody: OpenApiRequestBody | undefined) {
  if (!requestBody?.content) return;
  if (requestBody.content["application/json"]) return;
  throw new Error(
    `Allowed operation ${operationId} has unsupported request body content types: ${Object.keys(
      requestBody.content,
    ).join(", ")}`,
  );
}

function createTrimmedSpec(fullSpec: OpenApiSpec): {
  trimmedSpec: OpenApiSpec;
  selected: Array<{ path: string; method: HttpMethod; operation: OpenApiOperation }>;
} {
  const trimmedPaths: OpenApiSpec["paths"] = {};
  const selected: Array<{ path: string; method: HttpMethod; operation: OpenApiOperation }> = [];

  for (const [path, pathItem] of Object.entries(fullSpec.paths)) {
    const nextPathItem: OpenApiPathItem = {};
    if (pathItem.parameters) nextPathItem.parameters = pathItem.parameters;

    for (const method of METHOD_ORDER) {
      const operation = pathItem[method];
      if (!operation?.operationId || !ALLOWED_OPERATION_IDS.has(operation.operationId)) continue;
      nextPathItem[method] = operation;
      selected.push({ path, method, operation });
    }

    if (Object.keys(nextPathItem).length > (nextPathItem.parameters ? 1 : 0)) {
      trimmedPaths[path] = nextPathItem;
    }
  }

  const selectedIds = new Set(selected.map((entry) => entry.operation.operationId));
  const missingIds = [...ALLOWED_OPERATION_IDS].filter(
    (operationId) => !selectedIds.has(operationId),
  );
  if (missingIds.length > 0) {
    throw new Error(`Allowed operation IDs missing from spec: ${missingIds.join(", ")}`);
  }

  return {
    trimmedSpec: {
      ...fullSpec,
      paths: trimmedPaths,
    },
    selected,
  };
}

function buildGeneratedOperations(
  trimmedSpec: OpenApiSpec,
  selected: Array<{ path: string; method: HttpMethod; operation: OpenApiOperation }>,
): GeneratedOperation[] {
  const resolved = resolveRefs(trimmedSpec, trimmedSpec) as OpenApiSpec;

  return selected.map(({ path, method, operation }) => {
    const resolvedPathItem = resolved.paths[path]!;
    const resolvedOperation = resolvedPathItem[method]!;
    const params = [
      ...(resolvedPathItem.parameters ?? []),
      ...(resolvedOperation.parameters ?? []),
    ];

    assertJsonRequestBody(operation.operationId!, resolvedOperation.requestBody);

    const properties: Record<string, unknown> = {};
    const required = new Set<string>();
    const pathParams: string[] = [];
    const queryParams: string[] = [];
    const pathParamMap: Record<string, string> = {};
    const queryParamMap: Record<string, string> = {};
    let autoPaginateCollection = false;

    for (const parameter of params) {
      if (!parameter.name || (parameter.in !== "path" && parameter.in !== "query")) continue;
      const schema = withDescription(sanitizeSchema(parameter.schema), parameter.description);

      if (parameter.in === "path") {
        properties[parameter.name] = schema;
        pathParams.push(parameter.name);
        pathParamMap[parameter.name] = parameter.name;
        if (parameter.required) required.add(parameter.name);
        continue;
      }

      if (parameter.name === "page[size]" || parameter.name === "page[number]") {
        autoPaginateCollection = true;
        continue;
      }

      properties[parameter.name] = schema;
      queryParams.push(parameter.name);
      queryParamMap[parameter.name] = parameter.name;
      if (parameter.required) required.add(parameter.name);
    }

    const bodySchema = resolvedOperation.requestBody?.content?.["application/json"]?.schema;
    const hasBody = !!bodySchema;
    if (bodySchema) {
      properties.body = bodyInputSchema(bodySchema, resolvedOperation.requestBody?.description);
      if (resolvedOperation.requestBody?.required) required.add("body");
    }

    const requiredList = Object.keys(properties).filter((name) => required.has(name));
    const inputSchema = {
      type: "object",
      properties,
      required: requiredList.length > 0 ? requiredList : undefined,
      additionalProperties: false,
    };

    const methodUpper = method.toUpperCase() as GeneratedOperation["method"];
    const output = buildOutputSummary(operation, resolvedOperation);
    const propertyNames = Object.keys(properties);

    return {
      name: operation.operationId!,
      method: methodUpper,
      pathTemplate: path,
      description: (operation.description ?? operation.summary ?? `${methodUpper} ${path}`)
        .replace(/\s+/g, " ")
        .trim(),
      resourceGroup: resourceGroupForPath(path),
      annotations: annotationsForMethod(methodUpper),
      input: {
        required: requiredList,
        schema: inputSchema,
        pathParams,
        queryParams,
        hasBody,
      },
      wire: {
        pathParamMap,
        queryParamMap,
        ...(bodySchema ? { bodyContentType: "application/json" as const } : {}),
      },
      output: {
        ...output,
        ...(autoPaginateCollection ? { collection: { autoPaginate: true as const } } : {}),
      },
      meta: {
        inputSummary: summarizeInput(requiredList, propertyNames, hasBody),
      },
    };
  });
}

function renderOperationsModule(operations: GeneratedOperation[]) {
  return `// This file is generated by scripts/generate.ts. Do not edit manually.

import type { GeneratedOperation } from "./types.ts";

export const GENERATED_OPERATIONS = ${JSON.stringify(
    operations,
    null,
    2,
  )} satisfies GeneratedOperation[];
`;
}

async function runOpenApiTypescript(trimmedSpecPath: string, outputPath: string) {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "npm:openapi-typescript@7.10.1", trimmedSpecPath, "-o", outputPath],
    stdout: "inherit",
    stderr: "inherit",
  });

  const { code } = await command.output();
  if (code !== 0) throw new Error("openapi-typescript generation failed");
}

function renderAllowlistDoc(
  fullSpec: OpenApiSpec,
  selected: Array<{ path: string; method: HttpMethod; operation: OpenApiOperation }>,
) {
  const allOperations = Object.entries(fullSpec.paths)
    .flatMap(([path, pathItem]) =>
      METHOD_ORDER.flatMap((method) => {
        const operation = pathItem[method];
        if (!operation?.operationId) return [];
        return [
          {
            operationId: operation.operationId,
            method: method.toUpperCase(),
            path,
          },
        ];
      }),
    )
    .sort((left, right) => left.operationId.localeCompare(right.operationId));

  const allowedIds = new Set(selected.map((entry) => entry.operation.operationId!));
  const allowed = allOperations.filter((entry) => allowedIds.has(entry.operationId));
  const blocked = allOperations.filter((entry) => !allowedIds.has(entry.operationId));

  const renderEntries = (entries: typeof allOperations) =>
    entries
      .map((entry) => `- \`${entry.operationId}\` | ${entry.method} \`${entry.path}\``)
      .join("\n");

  return `# Operation Allowlist

Generated by \`scripts/generate.ts\`. Do not edit manually.

Total upstream operations: ${allOperations.length}
Allowed operations: ${allowed.length}
Blocked operations: ${blocked.length}

## Allowed

${renderEntries(allowed)}

## Blocked

${renderEntries(blocked)}
`;
}

async function main() {
  const fullSpec = JSON.parse(await Deno.readTextFile(ROOT_SPEC_PATH)) as OpenApiSpec;
  const { trimmedSpec, selected } = createTrimmedSpec(fullSpec);
  const generatedOperations = buildGeneratedOperations(trimmedSpec, selected);

  await Deno.mkdir("generated", { recursive: true });
  await Deno.mkdir("src/generated", { recursive: true });
  await Deno.mkdir("docs", { recursive: true });

  await Deno.writeTextFile(TRIMMED_SPEC_PATH, JSON.stringify(trimmedSpec, null, 2) + "\n");
  await Deno.writeTextFile(GENERATED_OPERATIONS_PATH, renderOperationsModule(generatedOperations));
  await Deno.writeTextFile(ALLOWLIST_DOC_PATH, renderAllowlistDoc(fullSpec, selected) + "\n");
  await runOpenApiTypescript(TRIMMED_SPEC_PATH, GENERATED_TYPES_PATH);
}

if (import.meta.main) {
  await main();
}
