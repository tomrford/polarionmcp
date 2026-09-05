import { GENERATED_OPERATIONS } from "./generated/operations";

export type ToolCatalogEntry = {
  name: string;
  callable: string;
  description?: string;
  resource_group?: string;
  required_params: string[];
  optional_params: string[];
  input_summary?: string;
  output_summary?: string;
  annotations?: Record<string, unknown>;
  search_text: string;
  compact_text: string;
};

function schemaProperties(inputSchema: Record<string, unknown>): Record<string, unknown> {
  const properties = inputSchema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return {};
  return properties as Record<string, unknown>;
}

function schemaRequired(inputSchema: Record<string, unknown>): string[] {
  const required = inputSchema.required;
  if (!Array.isArray(required)) return [];
  return required.filter((value): value is string => typeof value === "string");
}

function schemaPropertyDescriptions(inputSchema: Record<string, unknown>): string[] {
  return Object.values(schemaProperties(inputSchema))
    .map((property) =>
      typeof property === "object" && property && "description" in property
        ? property.description
        : undefined,
    )
    .filter((value): value is string => typeof value === "string");
}

function compactSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function stemSearchToken(value: string): string {
  if (value.length > 4 && value.endsWith("ies")) return `${value.slice(0, -3)}y`;
  if (value.length > 3 && value.endsWith("s")) return value.slice(0, -1);
  return value;
}

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function buildToolCatalog(): ToolCatalogEntry[] {
  return GENERATED_OPERATIONS.map((operation) => {
    const required = new Set(schemaRequired(operation.input.schema));
    const properties = schemaProperties(operation.input.schema);
    const paramNames = Object.keys(properties);
    const searchSource = [
      operation.name,
      operation.description,
      operation.resourceGroup,
      operation.meta.inputSummary,
      operation.output.summary,
      ...paramNames,
      ...schemaPropertyDescriptions(operation.input.schema),
    ].join(" ");
    return {
      name: operation.name,
      callable: `codemode.${operation.name}`,
      description: operation.description,
      resource_group: operation.resourceGroup,
      required_params: paramNames.filter((name) => required.has(name)),
      optional_params: paramNames.filter((name) => !required.has(name)),
      input_summary: operation.meta.inputSummary,
      output_summary: operation.output.summary,
      annotations: operation.annotations,
      search_text: normalizeSearchText(searchSource),
      compact_text: compactSearchText(searchSource),
    };
  });
}

const CATALOG = buildToolCatalog();

export function searchCatalog(query: string, limit: number) {
  const normalizedQuery = normalizeSearchText(query);
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  const compactQuery = compactSearchText(query);

  const scored = CATALOG.map((entry) => {
    let score = 0;
    const haystack = entry.search_text;
    const compactHaystack = entry.compact_text;
    const normalizedName = normalizeSearchText(entry.name);
    const normalizedCallable = normalizeSearchText(entry.callable);
    if (haystack.includes(normalizedQuery)) score += 100;
    if (compactQuery && compactHaystack.includes(compactQuery)) score += 90;
    if (normalizedName === normalizedQuery) score += 120;
    if (normalizedCallable.includes(normalizedQuery)) score += 80;
    for (const token of tokens) {
      const stemmedToken = stemSearchToken(token);
      if (normalizedName.includes(token) || normalizedName.includes(stemmedToken)) score += 30;
      if (normalizedCallable.includes(token) || normalizedCallable.includes(stemmedToken)) {
        score += 20;
      }
      if (haystack.includes(token)) score += 10;
    }
    if (compactQuery) {
      const stemmedQuery = stemSearchToken(compactQuery);
      if (compactHaystack.includes(compactQuery) || compactHaystack.includes(stemmedQuery)) {
        score += 12;
      }
    }
    return { entry, score };
  })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));

  return {
    query,
    total_matches: scored.length,
    matches: scored.slice(0, limit).map(({ entry, score }) => ({
      name: entry.name,
      callable: entry.callable,
      resource_group: entry.resource_group,
      description: entry.description,
      required_params: entry.required_params,
      optional_params: entry.optional_params,
      input_summary: entry.input_summary,
      output_summary: entry.output_summary,
      annotations: entry.annotations,
      score,
    })),
  };
}

export function generatedOperationNames() {
  return GENERATED_OPERATIONS.map((operation) => operation.name);
}
