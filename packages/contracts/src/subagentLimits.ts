import * as Schema from "effect/Schema";

/** Cafe's resource-safety ceiling, not a claim about either provider's native default. */
export const MAX_CONCURRENT_SUBAGENTS = 64;
export const MaxConcurrentSubagents = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: MAX_CONCURRENT_SUBAGENTS }),
);
export type MaxConcurrentSubagents = typeof MaxConcurrentSubagents.Type;

/**
 * Durable requested policy, kept separate from model/effort traits. The whole
 * object is replaced: an omitted command field is unchanged, while `{}` resets
 * both families to instance/native policy. Claude's logical UI family name is
 * deliberately not its adapter routing slug (`claudeAgent`). These are native
 * admission ceilings, not an assertion that every kind of work is capped.
 */
export const SubagentLimits = Schema.Struct({
  codex: Schema.optional(MaxConcurrentSubagents),
  claude: Schema.optional(MaxConcurrentSubagents),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type SubagentLimits = typeof SubagentLimits.Type;
