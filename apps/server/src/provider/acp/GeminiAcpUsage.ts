import { UsageAccountingModel, type UsageAccountingSnapshot } from "@cafecode/contracts";
import * as Schema from "effect/Schema";
import type { PromptResponse } from "effect-acp/schema";

// ACP labels prompt-response usage unstable, so every response is validated
// against the expected token accounting invariants instead of version pinning.

const isAccountingModel = Schema.is(UsageAccountingModel);

function isTokenCount(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function readGeminiPromptUsage(
  model: string,
  response: PromptResponse,
  hasFollowUps: boolean,
):
  | {
      readonly model: UsageAccountingModel;
      readonly completeness: UsageAccountingSnapshot["completeness"];
    }
  | undefined {
  const usage = response.usage;
  if (!usage) return undefined;

  const {
    inputTokens,
    outputTokens,
    cachedReadTokens,
    cachedWriteTokens,
    thoughtTokens,
    totalTokens,
  } = usage;
  if (
    !isTokenCount(inputTokens) ||
    !isTokenCount(outputTokens) ||
    !isTokenCount(cachedReadTokens) ||
    !isTokenCount(totalTokens) ||
    cachedWriteTokens !== 0 ||
    (thoughtTokens != null && (!isTokenCount(thoughtTokens) || thoughtTokens > outputTokens))
  )
    return undefined;

  // Native input excludes cache reads; native output already includes thoughts.
  // A nonzero or absent write count lacks qualified accounting semantics.
  const inclusiveInput = inputTokens + cachedReadTokens;
  if (!Number.isSafeInteger(inclusiveInput) || inclusiveInput + outputTokens !== totalTokens) {
    return undefined;
  }

  const row = {
    model,
    inputTokens: inclusiveInput,
    cachedInputTokens: cachedReadTokens,
    cacheWriteInputTokens: cachedWriteTokens,
    outputTokens,
    reasoningOutputTokens: thoughtTokens ?? 0,
  };
  if (!isAccountingModel(row)) return undefined;
  return {
    model: row,
    // Intermediate RPCs can overlap the final native work. Only the last
    // admitted response is counted, so a group with follow-ups is partial.
    completeness:
      hasFollowUps || thoughtTokens == null || response.stopReason !== "end_turn"
        ? "partial"
        : "complete",
  };
}
