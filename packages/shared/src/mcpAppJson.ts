/** Pure browser/Node JSON admission shared by the sandbox preload and trusted
 * App broker. This module has no contracts, Effect, Electron or Node dependency.
 * Preserve the strict existing native lexical envelope: actual UTF-8 bytes,
 * structural depth and punctuation/string-token work are separate limits. */
export const MCP_APP_JSON_MAX_BYTES = 128 * 1024;
export const MCP_APP_JSON_MAX_DEPTH = 16;
export const MCP_APP_JSON_MAX_TOKENS = 4096;
// The private authenticated HTTP relay carries JSON as an opaque JSON string.
// A valid inner JSON string can double under escaping; finite owner scalars and
// envelope punctuation have their own allowance. This never raises the page's
// native App-message cap or authorizes the inner message by itself.
export const MCP_APP_JSON_MAX_TRANSPORT_BYTES = 2 * MCP_APP_JSON_MAX_BYTES + 8192;
const validByteBudget = (value: number, ceiling: number): boolean =>
  Number.isSafeInteger(value) && value > 0 && value <= ceiling;

export const encodeBoundedMcpAppTransportJson = (value: unknown): string | undefined =>
  encodeJson(value, MCP_APP_JSON_MAX_TRANSPORT_BYTES, MCP_APP_JSON_MAX_TRANSPORT_BYTES);
export const readBoundedMcpAppTransportJson = (
  text: unknown,
  maxBytes = MCP_APP_JSON_MAX_TRANSPORT_BYTES,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } =>
  readJson(text, maxBytes, MCP_APP_JSON_MAX_TRANSPORT_BYTES);

/** Encode received native data without first stringifying an arbitrarily large
 * object. Walk only plain JSON data, with the same depth/node/byte envelope as
 * the decoder. Accessors, custom prototypes, cycles and non-JSON values fail
 * closed; no received toJSON function is invoked on the trusted event lane. */
export function encodeBoundedMcpAppJson(
  value: unknown,
  maxBytes = MCP_APP_JSON_MAX_BYTES,
): string | undefined {
  return encodeJson(value, maxBytes, MCP_APP_JSON_MAX_BYTES);
}
function encodeJson(value: unknown, maxBytes: number, ceiling: number): string | undefined {
  if (!validByteBudget(maxBytes, ceiling)) return undefined;
  const chunks: string[] = [];
  const ancestors = new Set<object>();
  let bytes = 0;
  let nodes = 0;
  const append = (text: string) => {
    // Refuse by code units before allocating UTF-8. Any temporary escaped
    // scalar is itself derived from a separately bounded input string.
    if (text.length > maxBytes - bytes) throw new Error("Bound exceeded.");
    bytes += new TextEncoder().encode(text).byteLength;
    if (bytes > maxBytes) throw new Error("Bound exceeded.");
    chunks.push(text);
  };
  const scalar = (text: string) => {
    if (text.length > maxBytes - bytes) throw new Error("Bound exceeded.");
    append(JSON.stringify(text));
  };
  const visit = (entry: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MCP_APP_JSON_MAX_TOKENS || depth > MCP_APP_JSON_MAX_DEPTH)
      throw new Error("Bound exceeded.");
    if (entry === null) return append("null");
    if (typeof entry === "string") return scalar(entry);
    if (typeof entry === "boolean") return append(entry ? "true" : "false");
    if (typeof entry === "number" && Number.isFinite(entry)) return append(JSON.stringify(entry));
    if (typeof entry !== "object" || ancestors.has(entry)) throw new Error("Invalid JSON data.");
    const array = Array.isArray(entry);
    const prototype = Object.getPrototypeOf(entry);
    if (
      array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
    )
      throw new Error("Invalid JSON data.");
    ancestors.add(entry);
    if (array) {
      if (entry.length > MCP_APP_JSON_MAX_TOKENS) throw new Error("Bound exceeded.");
      append("[");
      for (let index = 0; index < entry.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(entry, String(index));
        if (!descriptor || !("value" in descriptor)) throw new Error("Invalid JSON data.");
        if (index > 0) append(",");
        visit(descriptor.value, depth + 1);
      }
      append("]");
    } else {
      append("{");
      let count = 0;
      // Unlike Object.entries/descriptors/ownKeys, this stops before allocating
      // an array containing every key of an excessive shallow native object.
      for (const key in entry) {
        count += 1;
        if (count > MCP_APP_JSON_MAX_TOKENS) throw new Error("Bound exceeded.");
        const descriptor = Object.getOwnPropertyDescriptor(entry, key);
        if (!descriptor || !("value" in descriptor)) throw new Error("Invalid JSON data.");
        if (count > 1) append(",");
        scalar(key);
        append(":");
        visit(descriptor.value, depth + 1);
      }
      append("}");
    }
    ancestors.delete(entry);
  };
  try {
    visit(value, 0);
    const encoded = chunks.join("");
    // Keep lexical work bounds identical even for dense primitive containers.
    return readJson(encoded, maxBytes, ceiling).ok ? encoded : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Admission precedes JSON.parse and bounds lexical work independently of bytes.
 * Quoted source is opaque text, not structural depth. Parser/decoder exceptions
 * never escape with private received content. This is not an authority decoder.
 */
export function readBoundedMcpAppJson(
  text: unknown,
  maxBytes = MCP_APP_JSON_MAX_BYTES,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  return readJson(text, maxBytes, MCP_APP_JSON_MAX_BYTES);
}
function readJson(
  text: unknown,
  maxBytes: number,
  ceiling: number,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  if (
    !validByteBudget(maxBytes, ceiling) ||
    typeof text !== "string" ||
    text.length === 0 ||
    text.length > maxBytes
  )
    return { ok: false };
  if (new TextEncoder().encode(text).byteLength > maxBytes) return { ok: false };
  let quoted = false;
  let escaped = false;
  let depth = 0;
  let nodes = 0;
  for (const character of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      nodes += 1;
    } else if (character === "{" || character === "[") {
      depth += 1;
      nodes += 1;
      if (depth > MCP_APP_JSON_MAX_DEPTH || nodes > MCP_APP_JSON_MAX_TOKENS) return { ok: false };
    } else if (character === "}" || character === "]") {
      depth -= 1;
      nodes += 1;
    } else if (character === "," || character === ":") {
      nodes += 1;
      if (nodes > MCP_APP_JSON_MAX_TOKENS) return { ok: false };
    }
    if (depth < 0 || depth > MCP_APP_JSON_MAX_DEPTH || nodes > MCP_APP_JSON_MAX_TOKENS)
      return { ok: false };
  }
  if (quoted || depth !== 0) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}
