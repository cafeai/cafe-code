import * as Schema from "effect/Schema";
import { IsoDateTime, PositiveInt } from "./baseSchemas.ts";

/** Presentation metadata only: none of these fields grant retry or child control. */
const DiagnosticIdentity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const DiagnosticLabel = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160));
export const ProviderDiagnosticSubject = Schema.Struct({
  kind: Schema.Literals(["root", "subagent", "unknown"]),
  id: Schema.optional(DiagnosticIdentity),
  label: Schema.optional(DiagnosticLabel),
});
export type ProviderDiagnosticSubject = typeof ProviderDiagnosticSubject.Type;

/** The only part admitted to ordinary activity snapshots and collapsed rows. */
export const ProviderDiagnosticSummary = Schema.Struct({
  version: Schema.Literal(1),
  status: Schema.Literals(["retry", "error"]),
  subject: ProviderDiagnosticSubject,
  observedRetryCount: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(1_024))),
  countLimited: Schema.optional(Schema.Literal(true)),
});
export type ProviderDiagnosticSummary = typeof ProviderDiagnosticSummary.Type;

/**
 * Private, error-only diagnostic copy. An explicit exact-owner reader serves
 * it separately from activity summaries. JSON is redacted/bounded at capture;
 * it is never an executable provider response or an authority calculation.
 */
export const ProviderDiagnosticSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  observedAt: IsoDateTime,
  source: DiagnosticIdentity,
  method: Schema.optional(DiagnosticIdentity),
  native: Schema.Struct({
    eventId: Schema.optional(DiagnosticIdentity),
    threadId: Schema.optional(DiagnosticIdentity),
    turnId: Schema.optional(DiagnosticIdentity),
    subagentRuntimeId: Schema.optional(DiagnosticIdentity),
    requestId: Schema.optional(DiagnosticIdentity),
  }),
  message: Schema.optional(Schema.String.check(Schema.isMaxLength(4_096))),
  json: Schema.String.check(Schema.isMaxLength(32_768)),
  redacted: Schema.Boolean,
  truncated: Schema.Boolean,
  omittedFields: Schema.Boolean,
});
export type ProviderDiagnosticSnapshot = typeof ProviderDiagnosticSnapshot.Type;

/**
 * Closed Cafe-authored presentation category for a provider retry/error.
 *
 * Derived only from structured fields in the bounded private copy (Codex
 * `codexErrorInfo`/HTTP status, Claude typed SDK error codes, Cafe-owned
 * process-exit facts), never from provider prose. It is published beside the
 * summary as the activity payload key `providerDiagnosticCategory` rather than
 * inside the strict v1 summary, so older renderers keep reading summaries.
 * A category only selects fixed Cafe copy and navigation shortcuts; it never
 * grants retry, recovery, permission or lifecycle authority.
 */
export const PROVIDER_DIAGNOSTIC_CATEGORIES = [
  "cyber-policy",
  "usage-policy",
  "model-at-capacity",
  "usage-limit",
  "rate-limit",
  "billing",
  "account-on-hold",
  "context-window",
  "session-budget",
  "sign-in-required",
  "verification-required",
  "model-unavailable",
  "speed-tier-unavailable",
  "connection",
  "server-error",
  "request-rejected",
  "sandbox",
  "too-many-denials",
  "process-exit",
  "response-limit",
] as const;
export const ProviderDiagnosticCategory = Schema.Literals(PROVIDER_DIAGNOSTIC_CATEGORIES);
export type ProviderDiagnosticCategory = typeof ProviderDiagnosticCategory.Type;

/** Server/provider transport only; do not embed this envelope in public activity payloads. */
export const ProviderDiagnostic = Schema.Struct({
  summary: ProviderDiagnosticSummary,
  snapshot: ProviderDiagnosticSnapshot,
});
export type ProviderDiagnostic = typeof ProviderDiagnostic.Type;
