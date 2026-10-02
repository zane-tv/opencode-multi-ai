/**
 * Sanitizes function names and clean JSON Schemas for Gemini Cloud Code internal API.
 */

export function sanitizeFunctionName(name: string): string {
  if (!name) return "_unknown";
  let s = name.replace(/[^a-zA-Z0-9_.:\-]/g, "_");
  if (!/^[a-zA-Z_]/.test(s)) s = "_" + s;
  return s.substring(0, 64);
}

const UNSUPPORTED_SCHEMA_CONSTRAINTS = new Set([
  "minLength",
  "maxLength",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "pattern",
  "minItems",
  "maxItems",
  "format",
  "default",
  "examples",
  "$schema",
  "$defs",
  "definitions",
  "const",
  "$ref",
  "$comment",
  "additionalProperties",
  "propertyNames",
  "patternProperties",
  "enumDescriptions",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "dependencies",
  "dependentSchemas",
  "dependentRequired",
  "title",
  "if",
  "then",
  "else",
  "contentMediaType",
  "contentEncoding",
]);

function removeUnsupportedKeywords(obj: unknown): void {
  if (!obj || typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    for (const item of obj) removeUnsupportedKeywords(item);
    return;
  }

  const record = obj as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (UNSUPPORTED_SCHEMA_CONSTRAINTS.has(key)) {
      delete record[key];
    } else {
      removeUnsupportedKeywords(record[key]);
    }
  }
}

function ensureObjectType(obj: unknown): void {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
  const record = obj as Record<string, unknown>;
  if (record.properties && !record.type) {
    record.type = "object";
  }
  for (const v of Object.values(record)) {
    ensureObjectType(v);
  }
}

function cleanupRequired(obj: unknown): void {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
  const record = obj as Record<string, unknown>;
  if (Array.isArray(record.required) && record.properties && typeof record.properties === "object") {
    const validRequired = (record.required as string[]).filter((f) =>
      Object.prototype.hasOwnProperty.call(record.properties, f),
    );
    if (validRequired.length === 0) {
      delete record.required;
    } else {
      record.required = validRequired;
    }
  }
  for (const v of Object.values(record)) {
    cleanupRequired(v);
  }
}

function addPlaceholders(obj: unknown): void {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
  const record = obj as Record<string, unknown>;
  if (record.type === "object") {
    if (!record.properties || Object.keys(record.properties as object).length === 0) {
      record.properties = {
        reason: {
          type: "string",
          description: "Brief explanation of why you are calling this tool",
        },
      };
      record.required = ["reason"];
    }
  }
  for (const v of Object.values(record)) {
    addPlaceholders(v);
  }
}

export function cleanJSONSchemaForAntigravity(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (!schema || typeof schema !== "object") return { type: "object" };

  const cleaned = structuredClone(schema);
  ensureObjectType(cleaned);
  removeUnsupportedKeywords(cleaned);
  cleanupRequired(cleaned);
  addPlaceholders(cleaned);

  return cleaned;
}
