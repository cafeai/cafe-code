import * as Data from "effect/Data";
/** Only these content-free categories may cross an untrusted transport boundary. */
export type RelayErrorCode =
  | "PROTOCOL_ERROR"
  | "BUSY"
  | "UNAVAILABLE"
  | "NOT_FOUND"
  | "EXPIRED"
  | "HOST_IDENTITY_MISMATCH"
  | "NETWORK_MISMATCH"
  | "ENVIRONMENT_MISMATCH"
  | "CRYPTO_FAILURE"
  | "AUTH_REQUIRED"
  | "AUTH_REJECTED"
  | "AUTH_DENIED"
  | "AUTH_INDETERMINATE"
  | "SECOND_FACTOR_REQUIRED"
  | "SECOND_FACTOR_REJECTED"
  | "SECOND_FACTOR_LOCKED"
  | "SESSION_REVOKED"
  | "INCOMPLETE";

export class RelayError extends Data.TaggedError("RelayError")<{ readonly code: RelayErrorCode }> {
  constructor(code: RelayErrorCode) {
    // Never incorporate a native exception, URL, peer ID, payload or credential.
    super({ code });
  }
  override get message(): string {
    return this.code;
  }
}

export function requireRelay(
  condition: unknown,
  code: RelayErrorCode = "PROTOCOL_ERROR",
): asserts condition {
  if (!condition) throw new RelayError(code);
}

/** URL parser exceptions can retain the entire invitation; discard them here. */
export function parseRelayUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new RelayError("PROTOCOL_ERROR");
  }
}
