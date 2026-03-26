import type { ReadOperationCatalogEntry } from "./read-types.ts";

type OpenApiParameter = {
  $ref?: string;
  in?: "path" | "query" | string;
  name?: string;
};

type OpenApiOperation = {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: OpenApiParameter[];
};

type OpenApiPathItem = {
  parameters?: OpenApiParameter[];
  get?: OpenApiOperation;
};

type OpenApiSpec = {
  paths: Record<string, OpenApiPathItem>;
};

function resourceGroupForPath(pathTemplate: string): ReadOperationCatalogEntry["resourceGroup"] {
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
  if (pathTemplate.includes("/pages")) return "pages";
  if (pathTemplate.includes("/collections")) return "collections";
  if (pathTemplate.includes("/enumerations")) return "enumerations";
  if (
    pathTemplate.includes("/users") ||
    pathTemplate === "/user" ||
    pathTemplate.includes("/usergroups")
  ) {
    return "users";
  }
  if (
    pathTemplate.includes("/customfields") ||
    pathTemplate.includes("getFieldsMetadata") ||
    pathTemplate === "/metadata"
  ) {
    return "metadata";
  }
  if (pathTemplate.startsWith("/projects") || pathTemplate === "/projecttemplates") {
    return "projects";
  }
  if (pathTemplate.startsWith("/roles")) return "roles";
  if (pathTemplate.startsWith("/revisions")) return "revisions";
  return "misc";
}

function sortedUnique(values: string[]) {
  return [...new Set(values)].sort();
}

async function loadReadOperationCatalog(): Promise<ReadOperationCatalogEntry[]> {
  const specUrl = new URL("../../polarionrest.json", import.meta.url);
  const spec = await Bun.file(specUrl).json() as OpenApiSpec;
  const entries: ReadOperationCatalogEntry[] = [];

  for (const [pathTemplate, pathItem] of Object.entries(spec.paths)) {
    const operation = pathItem.get;
    if (!operation?.operationId) continue;

    const pathParamNames: string[] = [];
    const queryParamNames: string[] = [];

    for (const params of [pathItem.parameters ?? [], operation.parameters ?? []]) {
      for (const parameter of params) {
        if (parameter.$ref || !parameter.name) continue;
        if (parameter.in === "path") pathParamNames.push(parameter.name);
        if (parameter.in === "query") queryParamNames.push(parameter.name);
      }
    }

    entries.push({
      operationId: operation.operationId,
      pathTemplate,
      pathParamNames: sortedUnique(pathParamNames),
      queryParamNames: sortedUnique(queryParamNames),
      resourceGroup: resourceGroupForPath(pathTemplate),
      isProjectScoped: pathTemplate.startsWith("/projects/{projectId}"),
      isAllScope: pathTemplate.startsWith("/all/"),
      description: (operation.description ?? operation.summary ?? "")
        .replace(/\s+/g, " ")
        .trim(),
    });
  }

  return entries.sort((a, b) => a.operationId.localeCompare(b.operationId));
}

// Derived from polarionrest.json GET operations at module load.
export const READ_OPERATION_CATALOG: ReadOperationCatalogEntry[] =
  await loadReadOperationCatalog();

export const READ_OPERATION_CATALOG_BY_ID = new Map(
  READ_OPERATION_CATALOG.map((entry) => [entry.operationId, entry]),
);
