import { createHash } from "node:crypto";
import { UsageAccountingSnapshot, type ThreadTokenUsageSnapshot } from "@cafecode/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const Count = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const ModelSlug = Schema.String.check(
  Schema.isMaxLength(256),
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._[\]:-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._[\]:-]*)*$/),
);
const Tokens = Schema.Struct({
  input: Count,
  output: Count,
  reasoning: Count,
  cache: Schema.Struct({ read: Count, write: Count }),
});
const Assistant = Schema.Struct({
  id: Identifier,
  sessionID: Identifier,
  role: Schema.Literal("assistant"),
  providerID: Schema.optional(Schema.String),
  modelID: Schema.optional(Schema.String),
  time: Schema.Struct({ created: Count }),
  tokens: Tokens,
});
const Step = Schema.Struct({
  id: Identifier,
  messageID: Identifier,
  sessionID: Identifier,
  type: Schema.Literal("step-finish"),
  tokens: Tokens,
});
type UsageStep = typeof Step.Type & { readonly reportedCostMicrousd?: string };
const decodeAssistant = Schema.decodeUnknownOption(Assistant);
const decodeStep = Schema.decodeUnknownOption(Step);
const decodeModel = Schema.decodeUnknownOption(ModelSlug);
const decodeSnapshot = Schema.decodeUnknownOption(UsageAccountingSnapshot);
const decodeLimit = Schema.decodeUnknownOption(
  Schema.Struct({ limit: Schema.Struct({ context: Count }) }),
);

/** SDK 1.18.3 / upstream 127bdb30784d508cc556c71a0f32b508a3061517:
 * session/session.ts getUsage subtracts cache from input and reasoning from
 * output. Cafe's canonical counts instead INCLUDE those subsets. Never add
 * tokens.total: it is an independently reported, optional provider total.
 * https://github.com/anomalyco/opencode/blob/127bdb30784d508cc556c71a0f32b508a3061517/packages/opencode/src/session/session.ts#L338-L406
 */
function tokenUsage(tokens: typeof Tokens.Type): ThreadTokenUsageSnapshot | undefined {
  const inputTokens = tokens.input + tokens.cache.read + tokens.cache.write;
  const outputTokens = tokens.output + tokens.reasoning;
  const usedTokens = inputTokens + outputTokens;
  if (!Number.isSafeInteger(usedTokens)) return;
  return {
    usedTokens,
    inputTokens,
    cachedInputTokens: tokens.cache.read,
    cacheWriteInputTokens: tokens.cache.write,
    outputTokens,
    reasoningOutputTokens: tokens.reasoning,
  };
}

function costMicrousd(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return;
  // The native API reports USD as a double; the existing ledger stores integer
  // micro-USD. Round each settled step once, retaining explicit zero estimates.
  const micros = Math.round(value * 1_000_000);
  return Number.isSafeInteger(micros) ? String(micros) : undefined;
}

export interface OpenCodeUsageIdentity {
  readonly instanceId: string;
  readonly threadId: string;
  readonly directory: string;
  readonly serverUrl: string | null;
  readonly sessionId: string;
}

/** Like Axiom's immutable request settlements, native step identities mint an
 * opaque cryptographic UUID. The same step after reconnect/duplicate delivery
 * reaches the SAME transactional ledger checkpoint; FIFO eviction cannot bill
 * it again. Private native coordinates never enter a public usage payload.
 */
function stepScope(identity: OpenCodeUsageIdentity, stepId: string): string {
  const bytes = createHash("sha256")
    .update(
      JSON.stringify([
        "cafe-opencode-step-usage-v1",
        identity.instanceId,
        identity.threadId,
        identity.directory,
        identity.serverUrl,
        identity.sessionId,
        stepId,
      ]),
    )
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const MESSAGE_LIMIT = 1_024;
const PENDING_LIMIT = 256;
const SEEN_LIMIT = 2_048;
const MODEL_LIMIT = 4_096;
const retain = <K, V>(map: Map<K, V>, key: K, value: V, limit: number) => {
  if (!map.has(key) && map.size >= limit) map.delete(map.keys().next().value!);
  map.set(key, value);
};

/** Numeric-only, bounded native observations. Model metadata may arrive after a
 * step, and the inventory can resolve after the first context observation.
 * Neither path scans history or counts assistant cost (which accumulates steps).
 */
export function makeOpenCodeUsage(identity: OpenCodeUsageIdentity) {
  const messages = new Map<string, string>();
  const pending = new Map<string, UsageStep>();
  const seen = new Map<string, true>();
  const limits = new Map<string, number>();
  let latest:
    | { id: string; created: number; model: string; usage: ThreadTokenUsageSnapshot }
    | undefined;
  let publishedContext: string | undefined;

  const context = (): ThreadTokenUsageSnapshot | undefined => {
    if (!latest) return;
    const maxTokens = limits.get(latest.model);
    const usage = { ...latest.usage, ...(maxTokens ? { maxTokens } : {}) };
    const key = JSON.stringify(usage);
    if (key === publishedContext) return;
    publishedContext = key;
    return usage;
  };

  const settle = (step: UsageStep): UsageAccountingSnapshot | undefined => {
    const model = messages.get(step.messageID);
    if (!model || seen.has(step.id)) return;
    const usage = tokenUsage(step.tokens);
    if (!usage) return;
    const reportedCostMicrousd = step.reportedCostMicrousd;
    const decoded = decodeSnapshot({
      scopeId: stepScope(identity, step.id),
      revision: 1,
      completeness: "complete",
      models: [
        {
          model,
          ...usage,
          ...(reportedCostMicrousd !== undefined ? { reportedCostMicrousd } : {}),
        },
      ],
    });
    if (Option.isNone(decoded)) return;
    retain(seen, step.id, true, SEEN_LIMIT);
    return decoded.value;
  };

  return {
    observeMessage(value: unknown) {
      const accounting: UsageAccountingSnapshot[] = [];
      const decoded = decodeAssistant(value);
      if (Option.isNone(decoded) || decoded.value.sessionID !== identity.sessionId)
        return { accounting };
      const message = decoded.value;
      const reportedModel =
        message.providerID &&
        message.providerID.length <= 256 &&
        message.modelID &&
        message.modelID.length <= 256
          ? `${message.providerID}/${message.modelID}`
          : undefined;
      // A missing/unsupported native label does not erase proven numeric usage.
      // Never substitute the requested model or persist an opaque model/path.
      const model =
        reportedModel && Option.isSome(decodeModel(reportedModel)) ? reportedModel : "unknown";
      // A message cannot reassign already settled steps to another model.
      const previousModel = messages.get(message.id);
      if (previousModel && previousModel !== model) return { accounting };
      retain(messages, message.id, model, MESSAGE_LIMIT);
      for (const [id, step] of pending) {
        if (step.messageID !== message.id) continue;
        pending.delete(id);
        const snapshot = settle(step);
        if (snapshot) accounting.push(snapshot);
      }
      const usage = tokenUsage(message.tokens);
      // OpenCode's own context UI uses the latest nonempty assistant's disjoint
      // token sum, not session totals. A delayed older message cannot rewind it.
      // packages/app/src/components/session/session-context-metrics.ts#L28-L59
      if (
        usage &&
        usage.usedTokens > 0 &&
        (!latest || message.time.created > latest.created || message.id === latest.id)
      ) {
        latest = { id: message.id, created: message.time.created, model, usage };
      }
      return { accounting, context: context() };
    },
    observeStep(value: unknown): UsageAccountingSnapshot | undefined {
      const decoded = decodeStep(value);
      if (Option.isNone(decoded) || decoded.value.sessionID !== identity.sessionId) return;
      // Validate cost independently, retaining only its finite numeric result.
      // Invalid/missing cost cannot discard valid tokens, and an opaque native
      // cost object must never stay in the pending join.
      const reportedCostMicrousd = costMicrousd(
        typeof value === "object" && value !== null && "cost" in value ? value.cost : undefined,
      );
      const step: UsageStep = {
        ...decoded.value,
        ...(reportedCostMicrousd !== undefined ? { reportedCostMicrousd } : {}),
      };
      if (!messages.has(step.messageID)) {
        retain(pending, step.id, step, PENDING_LIMIT);
        return;
      }
      return settle(step);
    },
    updateLimits(value: unknown): ThreadTokenUsageSnapshot | undefined {
      // Retain only exact model slugs and safe positive limits, never inventory
      // headers/options. Bound response traversal as well as retained state.
      if (
        typeof value !== "object" ||
        value === null ||
        !("all" in value) ||
        !Array.isArray(value.all) ||
        value.all.length > MODEL_LIMIT
      )
        return;
      limits.clear();
      let visited = 0;
      for (const provider of value.all) {
        if (
          typeof provider !== "object" ||
          provider === null ||
          typeof provider.id !== "string" ||
          provider.id.length > 256 ||
          typeof provider.models !== "object" ||
          provider.models === null ||
          Array.isArray(provider.models)
        )
          continue;
        for (const [id, raw] of Object.entries(provider.models)) {
          if (++visited > MODEL_LIMIT) break;
          if (id.length > 256) continue;
          const model = `${provider.id}/${id}`;
          const limit = decodeLimit(raw);
          if (
            Option.isSome(decodeModel(model)) &&
            Option.isSome(limit) &&
            limit.value.limit.context > 0
          )
            limits.set(model, limit.value.limit.context);
        }
        if (visited >= MODEL_LIMIT) break;
      }
      return context();
    },
  };
}
