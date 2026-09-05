import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/**
 * Codex app-server currently caps goal objectives at 4,000 Unicode code
 * points. Effect's string-length refinement counts UTF-16 code units, so the
 * wire schema permits the largest valid surrogate-pair representation and the
 * provider boundary performs the exact code-point validation before sending
 * the objective upstream.
 */
export const PROVIDER_THREAD_GOAL_MAX_OBJECTIVE_CODE_POINTS = 4_000;
export const PROVIDER_THREAD_GOAL_MAX_OBJECTIVE_UTF16_UNITS =
  PROVIDER_THREAD_GOAL_MAX_OBJECTIVE_CODE_POINTS * 2;

export const ProviderThreadGoalStatus = Schema.Literals([
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
]);
export type ProviderThreadGoalStatus = typeof ProviderThreadGoalStatus.Type;

const ProviderThreadGoalObjective = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROVIDER_THREAD_GOAL_MAX_OBJECTIVE_UTF16_UNITS),
);

/**
 * Canonical, provider-owned goal state.
 *
 * `threadId` is always Cafe's authenticated thread id. Provider-native thread
 * ids remain inside the adapter process and are never accepted from clients.
 */
export const ProviderThreadGoal = Schema.Struct({
  threadId: ThreadId,
  objective: ProviderThreadGoalObjective,
  status: ProviderThreadGoalStatus,
  tokenBudget: Schema.NullOr(PositiveInt),
  tokensUsed: NonNegativeInt,
  timeUsedSeconds: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProviderThreadGoal = typeof ProviderThreadGoal.Type;

export const ProviderThreadGoalGetInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProviderThreadGoalGetInput = typeof ProviderThreadGoalGetInput.Type;

export const ProviderThreadGoalSetInput = Schema.Struct({
  threadId: ThreadId,
  objective: Schema.optional(Schema.NullOr(ProviderThreadGoalObjective)),
  status: Schema.optional(Schema.NullOr(ProviderThreadGoalStatus)),
  tokenBudget: Schema.optional(Schema.NullOr(PositiveInt)),
});
export type ProviderThreadGoalSetInput = typeof ProviderThreadGoalSetInput.Type;

export const ProviderThreadGoalClearInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProviderThreadGoalClearInput = typeof ProviderThreadGoalClearInput.Type;

export const ProviderThreadGoalClearResult = Schema.Struct({
  cleared: Schema.Boolean,
});
export type ProviderThreadGoalClearResult = typeof ProviderThreadGoalClearResult.Type;
