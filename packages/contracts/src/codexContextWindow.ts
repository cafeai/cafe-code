import * as Schema from "effect/Schema";

/**
 * Explicit chat-local requested token count, not a model-capacity entitlement.
 * Safe integer transport preserves the exact value through JSON and SQLite;
 * no product/model ceiling or implicit default is invented here.
 */
export const CodexContextWindowOverride = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
export type CodexContextWindowOverride = typeof CodexContextWindowOverride.Type;

/** Shared schema predicate for input validation before any lifecycle side effect. */
export const validCodexContextWindowOverride: (value: number) => boolean = Schema.is(
  CodexContextWindowOverride,
);
