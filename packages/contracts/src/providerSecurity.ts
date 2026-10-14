import * as Schema from "effect/Schema";
import { IsoDateTime, SubagentRuntimeId, ThreadId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const Detail = Schema.String.check(Schema.isMaxLength(8192));
const Timestamp = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const Fingerprint = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/i));

/** Public native verifier output, never private keys or a Cafe cryptographic verdict. */
export const ProviderAttestationStatus = Schema.Struct({
  state: Schema.Literals([
    "unverified",
    "verifying",
    "unattested_development",
    "verified",
    "degraded",
    "outdated",
    "failed",
  ]),
  detail: Schema.optional(Detail),
});
export type ProviderAttestationStatus = typeof ProviderAttestationStatus.Type;

export const ProviderAttestationEvidence = Schema.Struct({
  status: ProviderAttestationStatus,
  providerId: Identifier,
  modelId: Identifier,
  attestationProtocol: Identifier,
  e2eeProtocol: Identifier,
  e2eeEncryptionVersion: Timestamp,
  trustPolicyVersion: Identifier,
  verifiedAtUnixSeconds: Timestamp,
  hardExpiresAtUnixSeconds: Timestamp,
  attestationGeneration: Schema.optional(Schema.NullOr(Timestamp)),
  modelKeyFingerprint: Fingerprint,
  tlsSpkiFingerprint: Schema.optional(Schema.NullOr(Fingerprint)),
  checks: Schema.Array(
    Schema.Struct({ name: Identifier, passed: Schema.Boolean, detail: Detail }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  providerClaims: Schema.Array(Schema.Struct({ name: Identifier, value: Detail })).check(
    Schema.isMaxLength(128),
  ),
  workloadManifest: Schema.optional(
    Schema.NullOr(Schema.String.check(Schema.isMaxLength(1024 * 1024))),
  ),
});
export type ProviderAttestationEvidence = typeof ProviderAttestationEvidence.Type;

export const ProviderSecurityReport = Schema.Struct({
  runtimeId: SubagentRuntimeId,
  modelId: Identifier,
  providerId: Identifier,
  observedAt: IsoDateTime,
  attestation: ProviderAttestationStatus,
  evidence: Schema.NullOr(ProviderAttestationEvidence),
  reply: Schema.Struct({
    state: Schema.Literals(["none", "verifying", "verified", "incomplete", "failed"]),
    turnId: Schema.optional(Identifier),
    modelId: Schema.optional(Identifier),
  }),
});
export type ProviderSecurityReport = typeof ProviderSecurityReport.Type;

/** All native coordinates are resolved by the server; renderer identifiers are fences. */
export const ProviderSecurityInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  threadId: ThreadId,
  runtimeId: SubagentRuntimeId,
  modelId: Identifier,
});
export type ProviderSecurityInput = typeof ProviderSecurityInput.Type;
/** Backend-resolved configuration commitment, not part of the renderer API. */
export const ProviderSecurityReadInput = Schema.Struct({
  ...ProviderSecurityInput.fields,
  configurationKey: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export type ProviderSecurityReadInput = typeof ProviderSecurityReadInput.Type;
export const ProviderSecurityRefreshInput = Schema.Struct({
  ...ProviderSecurityInput.fields,
  acceptOutdatedTee: Schema.optional(Schema.Boolean),
});
export type ProviderSecurityRefreshInput = typeof ProviderSecurityRefreshInput.Type;
/** Trusted backend admission stamp also fences actions such as native consent. */
export const ProviderSecurityNativeRefreshInput = Schema.Struct({
  ...ProviderSecurityRefreshInput.fields,
  configurationKey: ProviderSecurityReadInput.fields.configurationKey,
});
export type ProviderSecurityNativeRefreshInput = typeof ProviderSecurityNativeRefreshInput.Type;
export const ProviderSecurityResult = Schema.Struct({
  report: Schema.NullOr(ProviderSecurityReport),
});
export type ProviderSecurityResult = typeof ProviderSecurityResult.Type;
