import {
  ProviderInteraction as InteractionSchema,
  ProviderInteractionResponse as ResponseSchema,
  type ProviderInteraction,
  type ProviderInteractionField,
  type ProviderElicitation,
  type ProviderInteractionResponse,
} from "@cafecode/contracts";
import * as Schema from "effect/Schema";
const isInteraction = Schema.is(InteractionSchema);
const isInteractionResponse = Schema.is(ResponseSchema);

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const text = (value: unknown, max = 8192): value is string =>
  typeof value === "string" &&
  value.length <= max &&
  // oxlint-disable-next-line no-control-regex -- Reject unsafe provider-authored control bytes.
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
const safeKey = (key: string) =>
  key.length > 0 && key.length <= 128 && !["__proto__", "prototype", "constructor"].includes(key);

/** No fetch or automatic navigation. The caller keeps this value transient. */
export function getSafeInteractionUrl(value: unknown): string | null {
  if (!text(value) || /[\s\\]/u.test(value)) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function parseOptions(value: unknown): ProviderInteractionField["options"] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return null;
  const result: Array<{ value: string; label: string }> = [];
  for (const entry of value) {
    const object = record(entry);
    if (object && Object.keys(object).some((key) => key !== "const" && key !== "title"))
      return null;
    const option =
      typeof entry === "string"
        ? { value: entry, label: entry }
        : { value: object?.const, label: object?.title ?? object?.const };
    if (
      !text(option.value, 1024) ||
      !text(option.label, 1024) ||
      result.some((row) => row.value === option.value)
    )
      return null;
    result.push({ value: option.value, label: option.label });
  }
  return result;
}

/**
 * Normalize only the MCP primitive/enum vocabulary. Unsupported constraints
 * fail closed rather than silently asking the user to approve a weaker form.
 * This is deliberately not a generic JSON-Schema evaluator or regex runner.
 */
export function normalizeElicitationRequest(input: unknown): ProviderElicitation | null {
  const request = record(input);
  if (!request || !text(request.message) || !text(request.serverName, 1024)) return null;
  const common = {
    kind: "elicitation" as const,
    serverName: request.serverName,
    message: request.message,
  };
  if (request.mode === "url") {
    const url = getSafeInteractionUrl(request.url);
    const normalized = url
      ? {
          ...common,
          message: "The MCP server requests that you complete an external authorization step.",
          mode: "url" as const,
          urlOrigin: new URL(url).origin,
        }
      : null;
    return isInteraction(normalized) ? normalized : null;
  }
  if (!["form", "openai/form", "openaiForm"].includes(String(request.mode))) return null;
  const schema = record(request.requestedSchema);
  const properties = record(schema?.properties);
  if (!schema || schema.type !== "object" || !properties || Object.keys(properties).length > 32)
    return null;
  if (
    Object.keys(schema).some(
      (key) =>
        ![
          "type",
          "properties",
          "required",
          "title",
          "description",
          "$schema",
          "additionalProperties",
        ].includes(key),
    )
  )
    return null;
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false)
    return null;
  const required = schema.required ?? [];
  if (
    !Array.isArray(required) ||
    required.some((key) => typeof key !== "string" || !Object.hasOwn(properties, key)) ||
    new Set(required).size !== required.length
  )
    return null;
  const fields: ProviderInteractionField[] = [];
  for (const [id, raw] of Object.entries(properties)) {
    const field = record(raw);
    if (!safeKey(id) || !field) return null;
    const allowed = new Set([
      "type",
      "title",
      "description",
      "default",
      "enum",
      "enumNames",
      "oneOf",
      "anyOf",
      "items",
      "minimum",
      "maximum",
      "minLength",
      "maxLength",
      "minItems",
      "maxItems",
      "format",
    ]);
    if (Object.keys(field).some((key) => !allowed.has(key))) return null;
    const type = field.type;
    if (
      type !== "string" &&
      type !== "number" &&
      type !== "integer" &&
      type !== "boolean" &&
      type !== "array"
    )
      return null;
    if (
      !text(field.title ?? id, 1024) ||
      (field.description != null && !text(field.description, 1024))
    )
      return null;
    let options: ProviderInteractionField["options"];
    const items = record(field.items);
    if (
      [field, ...(items ? [items] : [])].some(
        (source) => ["enum", "oneOf", "anyOf"].filter((key) => source[key] != null).length > 1,
      )
    )
      return null;
    const rawOptions =
      type === "array"
        ? (items?.enum ?? items?.anyOf ?? items?.oneOf)
        : (field.enum ?? field.oneOf ?? field.anyOf);
    if (rawOptions !== undefined) {
      const parsed = parseOptions(rawOptions);
      if (!parsed || (type !== "string" && type !== "array")) return null;
      options = parsed;
      if (field.enumNames != null) {
        if (
          !Array.isArray(field.enumNames) ||
          field.enumNames.length !== options.length ||
          !field.enumNames.every((label) => text(label, 1024))
        )
          return null;
        options = options.map((option, index) => ({
          ...option,
          label: (field.enumNames as string[])[index]!,
        }));
      }
    }
    if (
      type === "array" &&
      (!options ||
        !items ||
        (items.type !== undefined && items.type !== "string") ||
        Object.keys(items).some((key) => !["type", "enum", "anyOf", "oneOf"].includes(key)))
    )
      return null;
    const limits: Record<string, number> = {};
    for (const key of [
      "minimum",
      "maximum",
      "minLength",
      "maxLength",
      "minItems",
      "maxItems",
    ] as const) {
      const value = field[key];
      if (value == null) continue;
      if (
        key === "minimum" || key === "maximum"
          ? type !== "number" && type !== "integer"
          : key === "minItems" || key === "maxItems"
            ? type !== "array"
            : type !== "string"
      )
        return null;
      if (typeof value !== "number" || !Number.isFinite(value)) return null;
      if (
        key !== "minimum" &&
        key !== "maximum" &&
        (!Number.isSafeInteger(value) || value < 0 || value > (key.includes("Items") ? 64 : 8192))
      )
        return null;
      limits[key] = value;
    }
    if (
      (limits.minimum ?? -Infinity) > (limits.maximum ?? Infinity) ||
      (limits.minLength ?? 0) > (limits.maxLength ?? 8192) ||
      (limits.minItems ?? 0) > (limits.maxItems ?? 64)
    )
      return null;
    const format = field.format;
    if (
      format != null &&
      (type !== "string" || !["email", "uri", "date", "date-time"].includes(String(format)))
    )
      return null;
    fields.push({
      id,
      type,
      title: (field.title ?? id) as string,
      required: required.includes(id),
      ...(field.description != null ? { description: field.description as string } : {}),
      ...limits,
      ...(options ? { options } : {}),
      ...(format != null ? { format: format as ProviderInteractionField["format"] } : {}),
    });
  }
  const normalized = { ...common, mode: "form" as const, fields };
  return isInteraction(normalized) &&
    new TextEncoder().encode(JSON.stringify(normalized)).byteLength <= 64 * 1024
    ? normalized
    : null;
}

function validValue(field: ProviderInteractionField, value: unknown): boolean {
  if (field.type === "boolean") return typeof value === "boolean";
  if (field.type === "number" || field.type === "integer")
    return (
      typeof value === "number" &&
      Number.isFinite(value) &&
      (field.type !== "integer" || Number.isSafeInteger(value)) &&
      value >= (field.minimum ?? -Infinity) &&
      value <= (field.maximum ?? Infinity)
    );
  if (field.type === "array")
    return (
      Array.isArray(value) &&
      value.length >= (field.minItems ?? 0) &&
      value.length <= (field.maxItems ?? 64) &&
      new Set(value).size === value.length &&
      value.every(
        (entry) =>
          typeof entry === "string" && field.options?.some((option) => option.value === entry),
      )
    );
  if (
    !text(value) ||
    Array.from(value).length < (field.minLength ?? 0) ||
    Array.from(value).length > (field.maxLength ?? 8192) ||
    (field.options && !field.options.some((option) => option.value === value))
  )
    return false;
  if (field.format === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
  if (field.format === "uri") {
    try {
      return Boolean(new URL(value).protocol);
    } catch {
      return false;
    }
  }
  if (field.format === "date")
    return (
      /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
      !Number.isNaN(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 10) === value
    );
  if (field.format === "date-time")
    return /^\d{4}-\d{2}-\d{2}T/u.test(value) && !Number.isNaN(Date.parse(value));
  return true;
}

/** Wrong/stale answers never consume a pending callback. No prototype writes. */
export function validateInteractionResponse(
  interaction: ProviderInteraction,
  answers: unknown,
): ProviderInteractionResponse | null {
  const envelope = record(answers);
  if (!envelope || Object.keys(envelope).length !== 1) return null;
  const raw = record(envelope.__cafeInteraction);
  if (
    !raw ||
    Object.keys(raw).some((key) => !["action", "content", "grantIds", "scope"].includes(key)) ||
    !isInteractionResponse(raw)
  )
    return null;
  // Both browser and provider-side validation share this byte bound. JSON
  // escaping is included; a multibyte form cannot bypass it with character counts.
  if (new TextEncoder().encode(JSON.stringify(raw)).byteLength > 64 * 1024) return null;
  if (raw.action !== "accept") return { action: raw.action, content: null };
  if (interaction.kind === "permissions") {
    if (
      raw.content != null ||
      !raw.grantIds ||
      new Set(raw.grantIds).size !== raw.grantIds.length ||
      raw.grantIds.some((id) => !interaction.grants.some((grant) => grant.id === id))
    )
      return null;
    return { action: "accept", grantIds: raw.grantIds, scope: raw.scope ?? "turn" };
  }
  if (raw.grantIds !== undefined || raw.scope !== undefined) return null;
  if (interaction.mode === "url")
    return raw.content == null ? { action: "accept", content: null } : null;
  const content = record(raw.content);
  if (
    !content ||
    Object.keys(content).some(
      (key) => !safeKey(key) || !interaction.fields.some((field) => field.id === key),
    )
  )
    return null;
  for (const field of interaction.fields) {
    if (!Object.hasOwn(content, field.id)) {
      if (field.required) return null;
      continue;
    }
    if (!validValue(field, content[field.id])) return null;
  }
  return { action: "accept", content: raw.content };
}
