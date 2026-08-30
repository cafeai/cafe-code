import { createHash } from "node:crypto";

import type { MessageId } from "@cafecode/contracts";

export const CODEX_STEER_CLIENT_CORRELATION_ID_PREFIX = "cafe-steer-v1:";
export const CODEX_STEER_CLIENT_CORRELATION_ID_BYTE_LENGTH =
  Buffer.byteLength(CODEX_STEER_CLIENT_CORRELATION_ID_PREFIX, "utf8") + 64;

const CODEX_STEER_CLIENT_CORRELATION_ID_PATTERN = /^cafe-steer-v1:[0-9a-f]{64}$/u;

/**
 * Derive the opaque correlation value that Codex echoes as `item.clientId`.
 *
 * Cafe entity ids are intentionally open strings: a valid MessageId may be
 * very large or contain internal control/format code points. Forwarding that
 * value directly would let an identifier expand provider state and diagnostic
 * keys, and restart-time validation could disagree with live correlation.
 * Domain-separated SHA-256 gives every exact id one fixed-size, deterministic
 * token. Hash the explicit UTF-16 code-unit representation rather than Node's
 * UTF-8 replacement encoding: entity-id schemas permit internal lone
 * surrogates, and UTF-8 would collapse every such code unit to U+FFFD before
 * hashing. Determinism lets a fresh runtime match provider evidence to trusted
 * acceptance state without persisting the raw id in Codex-owned state.
 */
export function buildCodexSteerClientCorrelationId(value: MessageId | string): string {
  const rawValue = String(value);
  const digest = createHash("sha256");
  digest.update("cafe-code/codex-provider-client-user-message-id/v1\0", "utf8");
  digest.update(`${Buffer.byteLength(rawValue, "utf16le")}:`, "utf8");
  digest.update(Buffer.from(rawValue, "utf16le"));
  return `${CODEX_STEER_CLIENT_CORRELATION_ID_PREFIX}${digest.digest("hex")}`;
}

/**
 * Validate and round-trip Cafe's fixed-size token from an untrusted provider
 * notification. Never reinterpret the token as a raw MessageId: after restart
 * only independently persisted acceptance evidence may map it back to the
 * original Cafe identifier.
 */
export function parseCodexSteerClientCorrelationId(value: string | undefined): string | undefined {
  return value !== undefined && CODEX_STEER_CLIENT_CORRELATION_ID_PATTERN.test(value)
    ? value
    : undefined;
}
