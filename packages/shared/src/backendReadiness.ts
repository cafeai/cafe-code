import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const BACKEND_READINESS_CHALLENGE_HEADER = "x-cafe-code-backend-challenge";
export const BACKEND_READINESS_PROOF_HEADER = "x-cafe-code-backend-proof";
const READINESS_DOMAIN = "cafecode.backend-readiness.v1\0";
const VALUE_PATTERN = /^[a-f0-9]{64}$/u;

/** Exact 32-byte, lowercase hexadecimal scalars only. In particular, combined
 * duplicate headers, whitespace and attacker-controlled coercions are refused
 * before crypto allocation. These values are never interpreted as paths. */
export function isBackendReadinessValue(value: unknown): value is string {
  return typeof value === "string" && value.length === 64 && VALUE_PATTERN.test(value);
}

/** Each actual child opening receives a new secret over its private bootstrap
 * descriptor. This is separate from browser/session authentication and is not
 * persisted, placed in argv/env, or transmitted in an HTTP request. */
export function mintBackendReadinessToken(): string {
  return randomBytes(32).toString("hex");
}

/** Every startup and watchdog probe owns a fresh challenge: an earlier valid
 * response cannot qualify another probe, even within the same child run. */
export function mintBackendReadinessChallenge(): string {
  return randomBytes(32).toString("hex");
}

export function createBackendReadinessProof(token: string, challenge: string): string {
  if (!isBackendReadinessValue(token) || !isBackendReadinessValue(challenge)) {
    // Never interpolate received tokens/challenges into errors or diagnostics.
    throw new Error("Backend readiness proof requires exact finite values.");
  }
  return createHmac("sha256", Buffer.from(token, "hex"))
    .update(READINESS_DOMAIN, "utf8")
    .update(challenge, "ascii")
    .digest("hex");
}

/** Prove possession of this exact run's private opening secret. This does not
 * authenticate arbitrary public environment descriptor data, grant browser
 * access, or make either profile a same-user OS/network sandbox. */
export function verifyBackendReadinessProof(
  token: string,
  challenge: string,
  proof: unknown,
): boolean {
  if (
    !isBackendReadinessValue(token) ||
    !isBackendReadinessValue(challenge) ||
    !isBackendReadinessValue(proof)
  ) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(proof, "hex"),
    Buffer.from(createBackendReadinessProof(token, challenge), "hex"),
  );
}
