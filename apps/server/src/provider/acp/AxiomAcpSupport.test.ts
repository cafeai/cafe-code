import { describe, expect, it } from "@effect/vitest";
import {
  ProviderAttestationEvidence,
  type ProviderAttestationEvidence as Evidence,
} from "@cafecode/contracts";
import * as Schema from "effect/Schema";
import {
  AXIOM_CLIENT_CAPABILITIES,
  axiomAccountKey,
  axiomConfigurationKey,
  axiomCreditBalance,
  axiomSpawnInput,
  negotiateAxiom,
  validateAxiomEvidence,
} from "./AxiomAcpSupport.ts";
import { AxiomSettings } from "@cafecode/contracts";

export const evidenceFixture = (now = Math.floor(Date.now() / 1000)): Evidence => ({
  status: { state: "verified" },
  providerId: "tinfoil",
  modelId: "test-model",
  attestationProtocol: "tinfoil-snp-sigstore-v1",
  e2eeProtocol: "tinfoil-ehbp-v1",
  e2eeEncryptionVersion: 1,
  trustPolicyVersion: "test-policy",
  verifiedAtUnixSeconds: now,
  hardExpiresAtUnixSeconds: now + 240,
  modelKeyFingerprint: "a".repeat(64),
  tlsSpkiFingerprint: "b".repeat(64),
  checks: [{ name: "SNP router", passed: true, detail: "Fixture quote checked" }],
  providerClaims: [],
});

describe("Axiom native protocol admission", () => {
  it.effect("negotiates the reviewed contracts independently of product version", () =>
    negotiateAxiom({
      protocolVersion: 1,
      agentCapabilities: {
        _meta: {
          axiom: {
            ...AXIOM_CLIENT_CAPABILITIES._meta.axiom,
            runtimeInstanceId: "10000000-0000-4000-8000-000000000001",
          },
        },
      },
      agentInfo: { name: "axiomcli", version: "0.1.13" },
    }).pipe((effect) => effect),
  );
  it("uses structured native argv, including executable paths with spaces", () => {
    const settings = Schema.decodeSync(AxiomSettings)({
      binaryPath: "/Applications/Example App/bin/axiomcli",
    });
    expect(axiomSpawnInput(settings, process.cwd(), { EXAMPLE: "$(inert)" })).toEqual({
      command: settings.binaryPath,
      args: ["acp", "--frontend", "cli"],
      cwd: process.cwd(),
      env: { EXAMPLE: "$(inert)" },
    });
    expect(axiomAccountKey("private-account")).toMatch(/^[a-f0-9]{64}$/);
    expect(axiomAccountKey("private-account")).not.toContain("private-account");
  });
  it("admits the actual Tinfoil scope without inventing a relay lease", () => {
    const evidence = evidenceFixture(1000);
    expect(
      validateAxiomEvidence({ status: { state: "verified" }, evidence }, "test-model", 1001),
    ).toEqual(evidence);
    expect(Schema.is(ProviderAttestationEvidence)(evidence)).toBe(true);
  });
  it("commits effective executable/environment values without presentation flags and preserves microUSD", () => {
    const key = axiomConfigurationKey({}, [
      { name: "PRIVATE", value: "secret-value", sensitive: true },
      { name: "ORDER", value: "second" },
    ]);
    expect(key).toEqual(
      axiomConfigurationKey({ enabled: false }, [
        { name: "ORDER", value: "old" },
        { name: "PRIVATE", value: "secret-value", sensitive: false },
        { name: "ORDER", value: "second" },
      ]),
    );
    expect(key).not.toContain("secret-value");
    expect(key).not.toEqual(
      axiomConfigurationKey({ binaryPath: "other-cli" }, [
        { name: "PRIVATE", value: "secret-value" },
        { name: "ORDER", value: "second" },
      ]),
    );
    expect(axiomCreditBalance(1000001)).toBe("1.000001");
    expect(axiomCreditBalance(-1)).toBe("-0.000001");
    expect(axiomCreditBalance(Number.MAX_SAFE_INTEGER)).toBe("9007199254.740991");
  });
  it("rejects wrong model, expiry, future verification and unregistered protocols", () => {
    const evidence = evidenceFixture(1000);
    for (const invalid of [
      { ...evidence, modelId: "another-model" },
      { ...evidence, hardExpiresAtUnixSeconds: 1001 },
      { ...evidence, verifiedAtUnixSeconds: 1200 },
      { ...evidence, e2eeProtocol: "tls-only" },
      { ...evidence, checks: [{ name: "SNP router", passed: false, detail: "Failure" }] },
    ])
      expect(() =>
        validateAxiomEvidence(
          { status: { state: "verified" }, evidence: invalid },
          "test-model",
          1001,
        ),
      ).toThrow();
  });
  it("allows only the exact explicitly degraded NEAR posture", () => {
    const evidence: Evidence = {
      ...evidenceFixture(1000),
      status: { state: "degraded" },
      providerId: "near",
      attestationProtocol: "near-tdx-nvidia-v2",
      e2eeProtocol: "near-v3",
      e2eeEncryptionVersion: 2,
      attestationGeneration: 1,
      checks: [
        { name: "Intel TDX", passed: false, detail: "OutOfDate" },
        { name: "NVIDIA", passed: true, detail: "GPU checked" },
      ],
    };
    expect(
      validateAxiomEvidence({ status: { state: "degraded" }, evidence }, "test-model", 1001),
    ).toEqual(evidence);
    expect(() =>
      validateAxiomEvidence({ status: { state: "verified" }, evidence }, "test-model", 1001),
    ).toThrow();
    expect(() =>
      validateAxiomEvidence(
        {
          status: { state: "degraded" },
          evidence: {
            ...evidence,
            checks: [...evidence.checks, { name: "GPU", passed: false, detail: "Revoked" }],
          },
        },
        "test-model",
        1001,
      ),
    ).toThrow();
    expect(
      validateAxiomEvidence({ status: { state: "outdated" }, evidence: null }, "test-model", 1001),
    ).toBeNull();
  });
});
