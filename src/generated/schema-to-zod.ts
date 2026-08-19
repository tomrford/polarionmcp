import { z } from "zod";

type JsonSchema = Record<string, unknown>;

function literalSchema(value: unknown) {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return z.literal(value);
  }
  return z.unknown();
}

function unionSchemas(schemas: z.ZodTypeAny[]) {
  if (schemas.length === 0) return z.unknown();
  if (schemas.length === 1) return schemas[0]!;
  const [first, second, ...rest] = schemas;
  let current = z.union([first!, second!]);
  for (const schema of rest) {
    current = z.union([current, schema]);
  }
  return current;
}

function applyCommonValidations(base: z.ZodTypeAny, schema: JsonSchema) {
  let current = base;

  if (typeof schema.description === "string") {
    current = current.describe(schema.description);
  }

  if (current instanceof z.ZodString) {
    let stringSchema = current;
    if (typeof schema.minLength === "number") stringSchema = stringSchema.min(schema.minLength);
    if (typeof schema.maxLength === "number") stringSchema = stringSchema.max(schema.maxLength);
    current = stringSchema;
  }

  if (current instanceof z.ZodNumber) {
    let numberSchema = current;
    if (typeof schema.minimum === "number") numberSchema = numberSchema.min(schema.minimum);
    if (typeof schema.maximum === "number") numberSchema = numberSchema.max(schema.maximum);
    current = numberSchema;
  }

  if (schema.nullable === true) {
    current = current.nullable();
  }

  return current;
}

function propertySchema(value: unknown): z.ZodTypeAny {
  if (!value || typeof value !== "object" || Array.isArray(value)) return z.unknown();
  return jsonSchemaToZod(value as JsonSchema);
}

export function jsonSchemaToZod(schema: JsonSchema | undefined): z.ZodTypeAny {
  if (!schema || Object.keys(schema).length === 0) return z.unknown();

  if ("const" in schema) {
    return applyCommonValidations(literalSchema(schema.const), schema);
  }

  if (Array.isArray(schema.enum)) {
    return applyCommonValidations(
      unionSchemas(schema.enum.map((value) => literalSchema(value))),
      schema,
    );
  }

  if (Array.isArray(schema.oneOf)) {
    return applyCommonValidations(
      unionSchemas(schema.oneOf.map((value) => propertySchema(value))),
      schema,
    );
  }

  if (Array.isArray(schema.anyOf)) {
    return applyCommonValidations(
      unionSchemas(schema.anyOf.map((value) => propertySchema(value))),
      schema,
    );
  }

  if (Array.isArray(schema.allOf)) {
    const schemas = schema.allOf.map((value) => propertySchema(value));
    if (schemas.length === 0) return z.unknown();
    let current = schemas[0]!;
    for (const part of schemas.slice(1)) {
      current = z.intersection(current, part);
    }
    return applyCommonValidations(current, schema);
  }

  const type = schema.type ?? (schema.properties ? "object" : undefined);
  switch (type) {
    case "string":
      return applyCommonValidations(z.string(), schema);
    case "integer":
      return applyCommonValidations(z.number().int(), schema);
    case "number":
      return applyCommonValidations(z.number(), schema);
    case "boolean":
      return applyCommonValidations(z.boolean(), schema);
    case "array":
      return applyCommonValidations(z.array(propertySchema(schema.items)), schema);
    case "object": {
      const properties =
        schema.properties && typeof schema.properties === "object"
          ? (schema.properties as Record<string, unknown>)
          : {};
      const required = new Set(
        Array.isArray(schema.required)
          ? schema.required.filter((value): value is string => typeof value === "string")
          : [],
      );
      const shape = Object.fromEntries(
        Object.entries(properties).map(([key, value]) => [
          key,
          required.has(key) ? propertySchema(value) : propertySchema(value).optional(),
        ]),
      );

      let current: z.ZodTypeAny;
      if (Object.keys(shape).length > 0) {
        current = z.object(shape);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        current = z.record(z.string(), propertySchema(schema.additionalProperties));
      } else if (schema.additionalProperties === true) {
        current = z.record(z.string(), z.unknown());
      } else {
        current = z.object({}).passthrough();
      }

      if (
        current instanceof z.ZodObject &&
        schema.additionalProperties &&
        typeof schema.additionalProperties === "object"
      ) {
        current = current.catchall(propertySchema(schema.additionalProperties));
      } else if (current instanceof z.ZodObject && schema.additionalProperties === true) {
        current = current.catchall(z.unknown());
      } else if (current instanceof z.ZodObject && schema.additionalProperties === false) {
        current = current.strict();
      }

      return applyCommonValidations(current, schema);
    }
    default:
      return applyCommonValidations(z.unknown(), schema);
  }
}
