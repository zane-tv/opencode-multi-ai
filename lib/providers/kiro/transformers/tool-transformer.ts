import { createHash } from "node:crypto";

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 9_216;
const REJECTED_SCHEMA_KEYS = new Set([
  "additionalProperties",
  "pattern",
  "format",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "$schema",
  "$id",
  "$ref",
  "$comment",
  "patternProperties",
  "propertyNames",
  "dependentSchemas",
  "dependentRequired",
  "if",
  "then",
  "else",
  "contains",
  "unevaluatedProperties",
  "unevaluatedItems",
  "not",
  "examples",
  "default",
  "const",
]);
const SCHEMA_MAP_KEYS = new Set(["properties", "$defs", "definitions"]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

export function normalizeKiroToolName(name: string, used?: Set<string>): string {
  const raw = name.trim() || "tool";
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (cleaned === raw && cleaned.length <= MAX_NAME_LENGTH && !used?.has(cleaned)) {
    used?.add(cleaned);
    return cleaned;
  }
  const base = cleaned.slice(0, 55) || "tool";
  for (let salt = 0; ; salt++) {
    const candidate = `${base}_${hash(salt === 0 ? raw : `${raw}#${salt}`)}`.slice(
      0,
      MAX_NAME_LENGTH,
    );
    if (!used?.has(candidate)) {
      used?.add(candidate);
      return candidate;
    }
  }
}

export function normalizeKiroToolUseId(id: string): string {
  const raw = id.trim() || "tool";
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned.length <= MAX_NAME_LENGTH
    ? cleaned
    : `${cleaned.slice(0, 55)}_${hash(raw)}`.slice(0, MAX_NAME_LENGTH);
}

export function normalizeKiroToolInput(input: unknown): Record<string, unknown> {
  if (input === null || input === undefined) return {};
  if (typeof input === "string") {
    try {
      const parsed: unknown = JSON.parse(input);
      return record(parsed) ?? { value: parsed };
    } catch {
      return { value: input };
    }
  }
  return record(input) ?? { value: input };
}

export function sanitizeKiroToolSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeKiroToolSchema);
  const object = record(value);
  if (!object) return value;
  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(object)) {
    if (REJECTED_SCHEMA_KEYS.has(key)) continue;
    if (key === "required" && Array.isArray(child) && child.length === 0) continue;
    if (SCHEMA_MAP_KEYS.has(key)) {
      const map = record(child);
      sanitized[key] = map
        ? Object.fromEntries(
            Object.entries(map).map(([name, schema]) => [
              name,
              sanitizeKiroToolSchema(schema),
            ]),
          )
        : sanitizeKiroToolSchema(child);
    } else {
      sanitized[key] = sanitizeKiroToolSchema(child);
    }
  }
  return sanitized;
}

export function ensureKiroRootObjectSchema(schema: unknown): Record<string, unknown> {
  const sanitized = record(sanitizeKiroToolSchema(schema)) ?? {};
  const composition = ["oneOf", "anyOf", "allOf"].some((key) =>
    Array.isArray(sanitized[key]),
  );
  if (!composition) {
    return sanitized.type === "object" ? sanitized : { ...sanitized, type: "object" };
  }
  const properties: Record<string, unknown> = {};
  const required = new Set<string>();
  const merge = (value: unknown, includeRequired: boolean): void => {
    const entry = record(value);
    const entryProperties = entry ? record(entry.properties) : undefined;
    if (entryProperties) Object.assign(properties, entryProperties);
    if (includeRequired && entry && Array.isArray(entry.required)) {
      for (const name of entry.required) if (typeof name === "string") required.add(name);
    }
  };
  merge(sanitized, true);
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    const variants = sanitized[key];
    if (Array.isArray(variants)) {
      for (const variant of variants) merge(variant, key === "allOf");
    }
  }
  const result: Record<string, unknown> = { type: "object" };
  if (Object.keys(properties).length > 0) result.properties = properties;
  if (required.size > 0) result.required = [...required];
  return result;
}

export type OpenCodeTool = {
  type?: string;
  name?: string;
  description?: string;
  input_schema?: unknown;
  function?: { name?: string; description?: string; parameters?: unknown };
  parameters?: unknown;
};

export function convertToolsToCodeWhisperer(tools: readonly OpenCodeTool[]) {
  const used = new Set<string>();
  return tools.map((tool) => {
    const name = normalizeKiroToolName(tool.name ?? tool.function?.name ?? "tool", used);
    const description = (tool.description ?? tool.function?.description ?? "").slice(
      0,
      MAX_DESCRIPTION_LENGTH,
    );
    const schema = tool.input_schema ?? tool.function?.parameters ?? tool.parameters ?? {};
    return {
      toolSpecification: {
        name,
        description: description || `Tool: ${name}`,
        inputSchema: { json: ensureKiroRootObjectSchema(schema) },
      },
    };
  });
}
