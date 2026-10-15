import { createHash } from "node:crypto";
import {
  UsageAccountingSnapshot,
  type UsageAccountingSnapshot as Snapshot,
} from "@cafecode/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

const Decimal = Schema.String.check(
  Schema.makeFilter(
    (value) => /^[0-9]{1,20}$/.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n,
  ),
);
export const AxiomRequestUsage = Schema.Struct({
  requestId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  modelId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  providerId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  turnId: Schema.optional(Schema.NullOr(Schema.String)),
  purpose: Schema.Literals(["conversation", "title", "compaction"]),
  state: Schema.Literals(["running", "completed", "failed", "cancelled"]),
  completeness: Schema.Literals(["unknown", "live", "final", "partial"]),
  inputTokens: Schema.NullOr(Decimal),
  cachedInputTokens: Schema.NullOr(Decimal),
  outputTokens: Schema.NullOr(Decimal),
  reasoningTokens: Schema.NullOr(Decimal),
  costMicrousd: Schema.NullOr(Decimal),
  settled: Schema.Boolean,
  responseVerified: Schema.Boolean,
  startedAtMs: Decimal,
  finishedAtMs: Schema.optional(Schema.NullOr(Decimal)),
});
const decodeUsage = Schema.decodeUnknownOption(AxiomRequestUsage);
const decodeSnapshot = Schema.decodeUnknownOption(UsageAccountingSnapshot);
const safeCount = (value: string) => {
  const exact = BigInt(value);
  return exact <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(exact) : undefined;
};

export function axiomUsageTimestamp(value: unknown): string | undefined {
  const decoded = decodeUsage(value);
  if (Option.isNone(decoded)) return;
  const millis = BigInt(decoded.value.finishedAtMs ?? decoded.value.startedAtMs);
  if (millis > 8_640_000_000_000_000n) return;
  const timestamp = new Date(Number(millis)).toISOString();
  return timestamp.length === 24 ? timestamp : undefined;
}

/** One immutable native settlement, shared by activity, timeline recovery and
 * helpers. Hashing private native coordinates gives Cafe a stable opaque UUID;
 * no account, request or transcript identifier enters the usage ledger. */
export function axiomUsageAccounting(
  accountKey: string,
  nativeSessionId: string,
  value: unknown,
): Snapshot | undefined {
  const decoded = decodeUsage(value);
  if (Option.isNone(decoded)) return;
  const usage = decoded.value;
  if (
    !usage.settled ||
    usage.state === "running" ||
    (usage.completeness !== "final" && usage.completeness !== "partial") ||
    usage.costMicrousd === null ||
    usage.inputTokens === null ||
    usage.cachedInputTokens === null ||
    usage.outputTokens === null
  )
    return;
  const input = safeCount(usage.inputTokens),
    cached = safeCount(usage.cachedInputTokens),
    output = safeCount(usage.outputTokens),
    reasoning = safeCount(usage.reasoningTokens ?? "0");
  if (
    input === undefined ||
    cached === undefined ||
    output === undefined ||
    reasoning === undefined
  )
    return;
  const bytes = createHash("sha256")
    .update(
      JSON.stringify([
        "cafe-axiom-request-accounting-v1",
        accountKey,
        nativeSessionId,
        usage.requestId,
      ]),
    )
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  const snapshot = decodeSnapshot({
    scopeId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    revision: 1,
    completeness: usage.completeness === "final" ? "complete" : "partial",
    models: [
      {
        model: usage.modelId,
        inputTokens: input,
        cachedInputTokens: cached,
        cacheWriteInputTokens: 0,
        outputTokens: output,
        reasoningOutputTokens: reasoning,
        reportedCostMicrousd: String(BigInt(usage.costMicrousd)),
      },
    ],
  });
  return Option.isSome(snapshot) ? snapshot.value : undefined;
}
