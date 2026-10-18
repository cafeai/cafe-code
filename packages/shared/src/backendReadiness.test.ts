import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  createBackendReadinessProof,
  isBackendReadinessValue,
  mintBackendReadinessChallenge,
  mintBackendReadinessToken,
  verifyBackendReadinessProof,
} from "./backendReadiness.ts";

describe("exact-child backend readiness proofs", () => {
  const token = "a1".repeat(32);
  const challenge = "b2".repeat(32);

  it("uses fresh finite independent opening tokens and per-probe challenges", () => {
    const tokens = [mintBackendReadinessToken(), mintBackendReadinessToken()];
    const challenges = [mintBackendReadinessChallenge(), mintBackendReadinessChallenge()];
    expect([...tokens, ...challenges].every(isBackendReadinessValue)).toBe(true);
    expect(new Set([...tokens, ...challenges]).size).toBe(4);
  });

  it("accepts only the domain-separated proof for the exact opening secret and challenge", () => {
    const proof = createBackendReadinessProof(token, challenge);
    const independent = createHmac("sha256", Buffer.from(token, "hex"))
      .update("cafecode.backend-readiness.v1\0", "utf8")
      .update(challenge, "ascii")
      .digest("hex");
    expect(proof).toBe(independent);
    expect(verifyBackendReadinessProof(token, challenge, proof)).toBe(true);
    expect(verifyBackendReadinessProof("c3".repeat(32), challenge, proof)).toBe(false);
    expect(verifyBackendReadinessProof(token, "d4".repeat(32), proof)).toBe(false);
    const unseparated = createHmac("sha256", Buffer.from(token, "hex"))
      .update(challenge, "ascii")
      .digest("hex");
    expect(verifyBackendReadinessProof(token, challenge, unseparated)).toBe(false);
  });

  it.each([
    undefined,
    null,
    1,
    {},
    [],
    "",
    "a".repeat(63),
    "a".repeat(65),
    "A".repeat(64),
    "g".repeat(64),
    `${"a".repeat(64)}, ${"b".repeat(64)}`,
    ` ${"a".repeat(64)}`,
  ])("refuses malformed or missing proof without coercion: %s", (proof) => {
    expect(isBackendReadinessValue(proof)).toBe(false);
    expect(verifyBackendReadinessProof(token, challenge, proof)).toBe(false);
  });

  it("refuses invalid secret/challenge inputs with fixed non-disclosing diagnostics", () => {
    for (const [secret, nonce] of [
      ["private fixture secret", challenge],
      [token, "private fixture challenge"],
    ]) {
      expect(verifyBackendReadinessProof(secret!, nonce!, "a".repeat(64))).toBe(false);
      expect(() => createBackendReadinessProof(secret!, nonce!)).toThrow(
        "Backend readiness proof requires exact finite values.",
      );
    }
  });
});
