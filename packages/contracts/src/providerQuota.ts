import * as Schema from "effect/Schema";
import { SubagentRuntimeId, ThreadId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/** A bounded, volatile level from one native session, not authenticated account
 * identity, a billing ledger, or permission to fetch provider metadata. */
export const PROVIDER_SESSION_QUOTA_MAX_METERS = 128;
export const PROVIDER_SESSION_QUOTA_MAX_CLASSIFICATION_CHARS = 64;
export const PROVIDER_SESSION_QUOTA_MAX_LABEL_CHARS = 256;
export const PROVIDER_SESSION_QUOTA_MAX_CURRENCY_CHARS = 16;

// These strings are inert display metadata. Reject control/bidi characters and
// lone UTF-16 units instead of repairing attacker-controlled labels or keys.
const text = (maximum: number) =>
  Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(maximum),
    Schema.isPattern(/^[^\p{Cc}\p{Cs}\p{Zl}\p{Zp}\p{Bidi_Control}]+$/u),
    Schema.makeFilter((value) => value.trim().length > 0),
  );
const Classification = text(PROVIDER_SESSION_QUOTA_MAX_CLASSIFICATION_CHARS);
const Label = text(PROVIDER_SESSION_QUOTA_MAX_LABEL_CHARS);
const Percent = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 }));
const MinorCurrencyAmount = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);

/** Canonical UTC receipt/reset instants. Date round-tripping also rejects
 * calendar overflow which Date.parse alone would silently normalize. */
export const ProviderSessionQuotaTimestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  Schema.makeFilter((value) => {
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
  }),
);

export const ProviderSessionQuotaMeter = Schema.Struct({
  kind: Classification,
  group: Classification,
  usedPercent: Percent,
  resetsAt: Schema.NullOr(ProviderSessionQuotaTimestamp),
  modelLabel: Schema.optional(Label),
  surfaceLabel: Schema.optional(Label),
  severity: Classification,
  isActive: Schema.Boolean,
});
export type ProviderSessionQuotaMeter = typeof ProviderSessionQuotaMeter.Type;

/** Amounts remain provider minor currency units; omission/unknown currency
 * never authorizes treating them as dollars or included-plan allowance. */
export const ProviderSessionQuotaExtraUsage = Schema.Struct({
  enabled: Schema.Boolean,
  monthlyLimit: Schema.NullOr(MinorCurrencyAmount),
  usedCredits: Schema.NullOr(MinorCurrencyAmount),
  usedPercent: Schema.NullOr(Percent),
  currency: Schema.optional(Schema.NullOr(text(PROVIDER_SESSION_QUOTA_MAX_CURRENCY_CHARS))),
});
export type ProviderSessionQuotaExtraUsage = typeof ProviderSessionQuotaExtraUsage.Type;

export const ProviderSessionQuotaReport = Schema.Struct({
  source: Schema.Literal("claude-session"),
  // This is Cafe's receipt time, never an asserted endpoint fetch timestamp.
  observedAt: ProviderSessionQuotaTimestamp,
  // Null is unavailable/no current rows. [] is an explicitly empty server level.
  meters: Schema.NullOr(
    Schema.Array(ProviderSessionQuotaMeter).check(
      Schema.isMaxLength(PROVIDER_SESSION_QUOTA_MAX_METERS),
    ),
  ),
  extraUsage: Schema.optional(Schema.NullOr(ProviderSessionQuotaExtraUsage)),
});
export type ProviderSessionQuotaReport = typeof ProviderSessionQuotaReport.Type;

/** Read-only subscription to owner-held session metadata. The optional exact
 * Cafe session/query binding prevents selecting a different chat by accident;
 * no native id, authentication identity, cwd, or provider prompt is accepted. */
export const ProviderSessionQuotaInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  session: Schema.optional(Schema.Struct({ threadId: ThreadId, runtimeId: SubagentRuntimeId })),
});
export type ProviderSessionQuotaInput = typeof ProviderSessionQuotaInput.Type;
export const ProviderSessionQuotaResult = Schema.Struct({
  report: Schema.NullOr(ProviderSessionQuotaReport),
});
export type ProviderSessionQuotaResult = typeof ProviderSessionQuotaResult.Type;
