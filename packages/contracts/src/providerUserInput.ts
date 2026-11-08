import * as Schema from "effect/Schema";

/** These are deliberate user actions, not synthetic answers or cancellation.
 * Providers must independently qualify support for the exact live callback. */
export const ProviderUserInputUnansweredDisposition = Schema.Literals(["skipped", "dismissed"]);
export type ProviderUserInputUnansweredDisposition =
  typeof ProviderUserInputUnansweredDisposition.Type;

export const USER_INPUT_UNANSWERED_MAX_QUESTIONS = 64;
export const USER_INPUT_UNANSWERED_MAX_KEY_CHARS = 16_384;
export const USER_INPUT_UNANSWERED_MAX_TOTAL_CHARS = 65_536;

export const ProviderUserInputUnanswered = Schema.Record(
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(USER_INPUT_UNANSWERED_MAX_KEY_CHARS),
  ),
  ProviderUserInputUnansweredDisposition,
).check(
  Schema.makeFilter(
    (value) => {
      const keys = Object.keys(value);
      return (
        keys.length <= USER_INPUT_UNANSWERED_MAX_QUESTIONS &&
        keys.reduce((total, key) => total + key.length, 0) <= USER_INPUT_UNANSWERED_MAX_TOTAL_CHARS
      );
    },
    { expected: "a bounded set of explicitly unanswered questions" },
  ),
);
export type ProviderUserInputUnanswered = typeof ProviderUserInputUnanswered.Type;

/** An annotation never silently wins over an actual answer. Full pending-ID
 * membership/completeness validation belongs to the current native owner. */
export const hasDisjointUserInputAnswers = (response: {
  readonly answers: Readonly<Record<string, unknown>>;
  readonly unanswered?: ProviderUserInputUnanswered | undefined;
}): boolean =>
  response.unanswered === undefined ||
  Object.keys(response.unanswered).every((key) => !Object.hasOwn(response.answers, key));
