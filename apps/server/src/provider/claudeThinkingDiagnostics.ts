/** The inspected prefix is diagnostic-only. No SDK context or conversation
 * block is truncated, and an uninspected tail must not bypass sanitization. */
const MAX_DIAGNOSTIC_CONTENT_BLOCKS = 256;
const OMITTED_CONTENT_BLOCKS_FIELD = "cafecode_content_blocks_omitted";

function omittedEnvelope(): Record<string, string> {
  return { type: "cafecode_diagnostic_omitted", reason: "malformed-sdk-envelope" };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Never evaluate an accessor or treat an inherited field as SDK authority. */
function own(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/** This is a shallow log projection, not a serializer for arbitrary JavaScript
 * objects. Null prototypes and own data properties prevent a copied accessor,
 * prototype setter, or envelope toJSON hook from resurrecting omitted data.
 * Ordinary tool inputs remain untouched: a tool's input.signature is not a
 * Claude thinking signature and must not be rewritten by a recursive scrubber. */
function cloneOwnData(
  value: Record<string, unknown>,
  omit: ReadonlySet<string> = new Set<string>(),
): Record<string, unknown> {
  const cloned: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value)) {
    if (key === "toJSON" || omit.has(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) continue;
    Object.defineProperty(cloned, key, {
      value: descriptor.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return cloned;
}

function isPrimary(source: Record<string, unknown>): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(source, "parent_tool_use_id");
  if (!descriptor) {
    // An absent optional marker is primary; an inherited marker is not an
    // absent marker. Do not read its value, including inherited getters.
    return !("parent_tool_use_id" in source);
  }
  // Blank strings, false, zero, objects and accessors all fail closed. Only the
  // exact supported null/undefined primary marker admits disclosed summaries.
  return "value" in descriptor && (descriptor.value === null || descriptor.value === undefined);
}

const OPAQUE_BLOCK_FIELDS = new Set(["signature", "signature_delta", "thinking"]);

function sanitizeBlock(value: unknown, primary: boolean): unknown {
  const source = record(value);
  if (!source) return "[omitted:malformed-content-block]";
  const type = own(source, "type");
  switch (type) {
    case "thinking":
    case "thinking_delta": {
      // These are provider-disclosed text, never decrypted/private reasoning.
      // A tiny allowlist also discards future opaque fields on thinking blocks.
      const thinking = own(source, "thinking");
      return { type, thinking: primary && typeof thinking === "string" ? thinking : "" };
    }
    case "redacted_thinking":
    case "signature_delta":
      // Preserve the fixed category for diagnostics, not its encrypted payload.
      return { type };
    default:
      if (typeof type !== "string") return "[omitted:malformed-content-block]";
      // Keep ordinary text/tool/forward-compatible blocks and their input data.
      // Only reserved thinking fields at this exact known block level are lost.
      return cloneOwnData(source, OPAQUE_BLOCK_FIELDS);
  }
}

function sanitizeAssistant(
  source: Record<string, unknown>,
  primary: boolean,
): Record<string, unknown> {
  const projected = cloneOwnData(source, new Set(["message"]));
  const message = record(own(source, "message"));
  if (!message) {
    // A malformed/accessor envelope must not retain an uninspected content path.
    projected.message = { content: [] };
    return projected;
  }
  const messageProjection = cloneOwnData(
    message,
    new Set(["content", OMITTED_CONTENT_BLOCKS_FIELD]),
  );
  const content = own(message, "content");
  const blocks: unknown[] = [];
  messageProjection.content = blocks;
  projected.message = messageProjection;
  if (!Array.isArray(content)) return projected;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(content, "length");
  const length =
    lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) return projected;
  const inspected = Math.min(length, MAX_DIAGNOSTIC_CONTENT_BLOCKS);
  for (let index = 0; index < inspected; index++) {
    // Do not consume array getters, inherited entries, iterators or species.
    const descriptor = Object.getOwnPropertyDescriptor(content, String(index));
    blocks.push(
      descriptor && "value" in descriptor
        ? sanitizeBlock(descriptor.value, primary)
        : "[omitted:malformed-content-block]",
    );
  }
  if (length > inspected) messageProjection[OMITTED_CONTENT_BLOCKS_FIELD] = length - inspected;
  return projected;
}

function sanitizeStreamEvent(
  source: Record<string, unknown>,
  primary: boolean,
): Record<string, unknown> {
  const projected = cloneOwnData(source, new Set(["event"]));
  const event = record(own(source, "event"));
  if (!event) {
    projected.event = {};
    return projected;
  }
  const eventProjection = cloneOwnData(event, new Set(["content_block", "delta"]));
  // Inspect only the SDK's content-block start/delta envelopes. Do not recurse
  // into arbitrary tool input, unrelated native frames or future object graphs.
  for (const key of ["content_block", "delta"]) {
    const descriptor = Object.getOwnPropertyDescriptor(event, key);
    if (!descriptor || !("value" in descriptor)) continue;
    const delta = record(descriptor.value);
    if (
      key === "delta" &&
      own(event, "type") !== "content_block_delta" &&
      delta &&
      typeof own(delta, "type") !== "string"
    ) {
      // message_delta has an untyped delta containing stop_reason rather than
      // a content block. Retain ordinary stop/usage diagnostics, not a malformed
      // content placeholder or an invented response classification.
      eventProjection[key] = cloneOwnData(delta, OPAQUE_BLOCK_FIELDS);
    } else {
      eventProjection[key] = sanitizeBlock(descriptor.value, primary);
    }
  }
  projected.event = eventProjection;
  return projected;
}

/** Forward-only operational-log projection of known Claude thinking envelopes.
 * Apply this to log/canonical diagnostic metadata, NEVER SDK input or retained
 * conversation blocks: opaque signatures are needed for provider roundtrips.
 * This is not a general secret scrubber. Unrelated envelopes retain their
 * existing diagnostic behavior, and ordinary nested tool fields are not read.
 */
export function sanitizeClaudeThinkingDiagnostics(message: unknown): unknown {
  try {
    const source = record(message);
    if (!source) return message;
    const typeDescriptor = Object.getOwnPropertyDescriptor(source, "type");
    if ((typeDescriptor && !("value" in typeDescriptor)) || (!typeDescriptor && "type" in source)) {
      // A malformed discriminator cannot route us around the known-envelope
      // filter and later execute its accessor during diagnostic serialization.
      return omittedEnvelope();
    }
    const type = own(source, "type");
    if (type === "assistant") return sanitizeAssistant(source, isPrimary(source));
    if (type === "stream_event") return sanitizeStreamEvent(source, isPrimary(source));
    return message;
  } catch {
    // An exceptional descriptor/proxy shape is not a reason to retain a native
    // payload we could not inspect. Fixed diagnostics contain no thrown values.
    return omittedEnvelope();
  }
}
