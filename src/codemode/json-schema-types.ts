// Adapted from @cloudflare/codemode 0.3.3 dist/json-schema-types-DoQ0VISs.js.

type JsonSchema =
  | boolean
  | {
      $ref?: string;
      type?: string | string[];
      anyOf?: JsonSchema[];
      oneOf?: JsonSchema[];
      allOf?: JsonSchema[];
      enum?: unknown[];
      const?: unknown;
      nullable?: boolean;
      prefixItems?: JsonSchema[];
      items?: JsonSchema | JsonSchema[];
      properties?: Record<string, JsonSchema>;
      required?: string[];
      additionalProperties?: boolean | JsonSchema;
      description?: string;
      format?: string;
    };

const JS_RESERVED = new Set([
  "abstract",
  "arguments",
  "await",
  "boolean",
  "break",
  "byte",
  "case",
  "catch",
  "char",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "double",
  "else",
  "enum",
  "eval",
  "export",
  "extends",
  "false",
  "final",
  "finally",
  "float",
  "for",
  "function",
  "goto",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "int",
  "interface",
  "let",
  "long",
  "native",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "short",
  "static",
  "super",
  "switch",
  "synchronized",
  "this",
  "throw",
  "throws",
  "transient",
  "true",
  "try",
  "typeof",
  "undefined",
  "var",
  "void",
  "volatile",
  "while",
  "with",
  "yield",
]);

export function sanitizeToolName(name: string): string {
  if (!name) return "_";
  let sanitized = name.replace(/[-.\s]/g, "_");
  sanitized = sanitized.replace(/[^a-zA-Z0-9_$]/g, "");
  if (!sanitized) return "_";
  if (/^[0-9]/.test(sanitized)) sanitized = `_${sanitized}`;
  if (JS_RESERVED.has(sanitized)) sanitized = `${sanitized}_`;
  return sanitized;
}

function toPascalCase(str: string): string {
  return str
    .replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())
    .replace(/^[a-z]/, (letter) => letter.toUpperCase());
}

function escapeControlChar(ch: string): string {
  const code = ch.charCodeAt(0);
  if (code <= 31 || code === 127) return `\\u${code.toString(16).padStart(4, "0")}`;
  return ch;
}

function quoteProp(name: string): string {
  if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)) {
    let escaped = "";
    for (const ch of name) {
      if (ch === "\\") escaped += "\\\\";
      else if (ch === '"') escaped += '\\"';
      else if (ch === "\n") escaped += "\\n";
      else if (ch === "\r") escaped += "\\r";
      else if (ch === "\t") escaped += "\\t";
      else if (ch === "\u2028") escaped += "\\u2028";
      else if (ch === "\u2029") escaped += "\\u2029";
      else escaped += escapeControlChar(ch);
    }
    return `"${escaped}"`;
  }
  return name;
}

function escapeStringLiteral(s: string): string {
  let out = "";
  for (const ch of s) {
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\u2028") out += "\\u2028";
    else if (ch === "\u2029") out += "\\u2029";
    else out += escapeControlChar(ch);
  }
  return out;
}

function escapeJsDoc(text: string): string {
  return text.replace(/\*\//g, "*\\/");
}

function resolveRef(ref: string, root: JsonSchema): JsonSchema | null {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return null;
  const segments = ref
    .slice(2)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: unknown = root;
  for (const seg of segments) {
    if (current === null || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[seg];
    if (typeof current === "undefined") return null;
  }
  if (typeof current === "boolean") return current;
  if (current === null || typeof current !== "object") return null;
  return current as JsonSchema;
}

function applyNullable(result: string, schema: Exclude<JsonSchema, boolean>): string {
  if (result !== "unknown" && result !== "never" && schema.nullable === true) {
    return `${result} | null`;
  }
  return result;
}

function jsonSchemaToTypeString(
  schema: JsonSchema,
  indent: string,
  ctx: {
    root: JsonSchema;
    depth: number;
    seen: Set<JsonSchema>;
    maxDepth: number;
  },
): string {
  if (typeof schema === "boolean") return schema ? "unknown" : "never";
  if (ctx.depth >= ctx.maxDepth) return "unknown";
  if (ctx.seen.has(schema)) return "unknown";
  ctx.seen.add(schema);

  const nextCtx = { ...ctx, depth: ctx.depth + 1 };

  try {
    if (schema.$ref) {
      const resolved = resolveRef(schema.$ref, ctx.root);
      if (!resolved) return "unknown";
      return applyNullable(jsonSchemaToTypeString(resolved, indent, nextCtx), schema);
    }
    if (schema.anyOf) {
      return applyNullable(
        schema.anyOf.map((s) => jsonSchemaToTypeString(s, indent, nextCtx)).join(" | "),
        schema,
      );
    }
    if (schema.oneOf) {
      return applyNullable(
        schema.oneOf.map((s) => jsonSchemaToTypeString(s, indent, nextCtx)).join(" | "),
        schema,
      );
    }
    if (schema.allOf) {
      return applyNullable(
        schema.allOf.map((s) => jsonSchemaToTypeString(s, indent, nextCtx)).join(" & "),
        schema,
      );
    }
    if (schema.enum) {
      if (schema.enum.length === 0) return "never";
      return applyNullable(
        schema.enum
          .map((value) => {
            if (value === null) return "null";
            if (typeof value === "string") return `"${escapeStringLiteral(value)}"`;
            if (typeof value === "object") return JSON.stringify(value) ?? "unknown";
            return String(value);
          })
          .join(" | "),
        schema,
      );
    }
    if (typeof schema.const !== "undefined") {
      return applyNullable(
        schema.const === null
          ? "null"
          : typeof schema.const === "string"
            ? `"${escapeStringLiteral(schema.const)}"`
            : typeof schema.const === "object"
              ? (JSON.stringify(schema.const) ?? "unknown")
              : String(schema.const),
        schema,
      );
    }

    if (schema.type === "string") return applyNullable("string", schema);
    if (schema.type === "number" || schema.type === "integer") {
      return applyNullable("number", schema);
    }
    if (schema.type === "boolean") return applyNullable("boolean", schema);
    if (schema.type === "null") return "null";

    if (schema.type === "array") {
      if (Array.isArray(schema.prefixItems)) {
        return applyNullable(
          `[${schema.prefixItems
            .map((s) => jsonSchemaToTypeString(s, indent, nextCtx))
            .join(", ")}]`,
          schema,
        );
      }
      if (Array.isArray(schema.items)) {
        return applyNullable(
          `[${schema.items.map((s) => jsonSchemaToTypeString(s, indent, nextCtx)).join(", ")}]`,
          schema,
        );
      }
      if (schema.items) {
        return applyNullable(`${jsonSchemaToTypeString(schema.items, indent, nextCtx)}[]`, schema);
      }
      return applyNullable("unknown[]", schema);
    }

    if (schema.type === "object" || schema.properties) {
      const props = schema.properties ?? {};
      const required = new Set(schema.required ?? []);
      const lines: string[] = [];

      for (const [propName, propSchema] of Object.entries(props)) {
        if (typeof propSchema === "boolean") {
          lines.push(
            `${indent}    ${quoteProp(propName)}${required.has(propName) ? "" : "?"}: ${
              propSchema ? "unknown" : "never"
            };`,
          );
          continue;
        }

        const propType = jsonSchemaToTypeString(propSchema, `${indent}    `, nextCtx);
        if (propSchema.description || propSchema.format) {
          const descText = propSchema.description
            ? escapeJsDoc(propSchema.description.replace(/\r?\n/g, " "))
            : undefined;
          const formatTag = propSchema.format
            ? `@format ${escapeJsDoc(propSchema.format)}`
            : undefined;
          if (descText && formatTag) {
            lines.push(`${indent}    /**`);
            lines.push(`${indent}     * ${descText}`);
            lines.push(`${indent}     * ${formatTag}`);
            lines.push(`${indent}     */`);
          } else {
            lines.push(`${indent}    /** ${descText ?? formatTag} */`);
          }
        }

        lines.push(
          `${indent}    ${quoteProp(propName)}${required.has(propName) ? "" : "?"}: ${propType};`,
        );
      }

      if (schema.additionalProperties) {
        const valueType =
          schema.additionalProperties === true
            ? "unknown"
            : jsonSchemaToTypeString(schema.additionalProperties, `${indent}    `, nextCtx);
        lines.push(`${indent}    [key: string]: ${valueType};`);
      }

      if (lines.length === 0) {
        if (schema.additionalProperties === false) return applyNullable("{}", schema);
        return applyNullable("Record<string, unknown>", schema);
      }

      return applyNullable(`{\n${lines.join("\n")}\n${indent}}`, schema);
    }

    if (Array.isArray(schema.type)) {
      return applyNullable(
        schema.type
          .map((type) => {
            if (type === "string") return "string";
            if (type === "number" || type === "integer") return "number";
            if (type === "boolean") return "boolean";
            if (type === "null") return "null";
            if (type === "array") return "unknown[]";
            if (type === "object") return "Record<string, unknown>";
            return "unknown";
          })
          .join(" | "),
        schema,
      );
    }

    return "unknown";
  } finally {
    ctx.seen.delete(schema);
  }
}

function jsonSchemaToType(schema: JsonSchema, typeName: string): string {
  return `type ${typeName} = ${jsonSchemaToTypeString(schema, "", {
    root: schema,
    depth: 0,
    seen: new Set(),
    maxDepth: 20,
  })}`;
}

function extractJsonSchemaDescriptions(
  schema: Exclude<JsonSchema, boolean>,
): Record<string, string> {
  const descriptions: Record<string, string> = {};
  if (schema.properties) {
    for (const [fieldName, propSchema] of Object.entries(schema.properties)) {
      if (propSchema && typeof propSchema === "object" && propSchema.description) {
        descriptions[fieldName] = propSchema.description;
      }
    }
  }
  return descriptions;
}

export function generateTypesFromJsonSchema(
  tools: Record<
    string,
    {
      description?: string;
      inputSchema: JsonSchema;
      outputSchema?: JsonSchema;
    }
  >,
): string {
  let availableTools = "";
  let availableTypes = "";

  for (const [toolName, tool] of Object.entries(tools)) {
    const safeName = sanitizeToolName(toolName);
    const typeName = toPascalCase(safeName);

    try {
      const inputType = jsonSchemaToType(tool.inputSchema, `${typeName}Input`);
      const outputType = tool.outputSchema
        ? jsonSchemaToType(tool.outputSchema, `${typeName}Output`)
        : `type ${typeName}Output = unknown`;

      availableTypes += `\n${inputType.trim()}`;
      availableTypes += `\n${outputType.trim()}`;

      const paramLines = (() => {
        try {
          const paramDescs = extractJsonSchemaDescriptions(
            tool.inputSchema as Exclude<JsonSchema, boolean>,
          );
          return Object.entries(paramDescs).map(
            ([fieldName, desc]) => `@param input.${fieldName} - ${desc}`,
          );
        } catch {
          return [] as string[];
        }
      })();

      const jsdocLines = [];
      if (tool.description?.trim()) {
        jsdocLines.push(escapeJsDoc(tool.description.trim().replace(/\r?\n/g, " ")));
      } else jsdocLines.push(escapeJsDoc(toolName));
      for (const line of paramLines) jsdocLines.push(escapeJsDoc(line.replace(/\r?\n/g, " ")));
      const jsdocBody = jsdocLines.map((line) => `\t * ${line}`).join("\n");

      availableTools += `\n\t/**\n${jsdocBody}\n\t */`;
      availableTools += `\n\t${safeName}: (input: ${typeName}Input) => Promise<${typeName}Output>;`;
      availableTools += "\n";
    } catch {
      availableTypes += `\ntype ${typeName}Input = unknown`;
      availableTypes += `\ntype ${typeName}Output = unknown`;
      availableTools += `\n\t/**\n\t * ${escapeJsDoc(toolName)}\n\t */`;
      availableTools += `\n\t${safeName}: (input: ${typeName}Input) => Promise<${typeName}Output>;`;
      availableTools += "\n";
    }
  }

  availableTools = `\ndeclare const codemode: {${availableTools}}`;

  return `
${availableTypes}
${availableTools}
  `.trim();
}
