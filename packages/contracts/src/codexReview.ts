import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

// Git references stay structured provider input. Reject control characters and
// option-shaped values before they reach any provider Git implementation; this
// is not shell escaping and never establishes filesystem or account authority.
const ReviewGitReference = TrimmedNonEmptyString.check(
  Schema.isMaxLength(512),
  Schema.isPattern(/^[^\s\p{Cc}-][^\s\p{Cc}]*$/u),
);

export const CodexReviewTarget = Schema.Union([
  Schema.Struct({ type: Schema.Literal("uncommittedChanges") }),
  Schema.Struct({ type: Schema.Literal("baseBranch"), branch: ReviewGitReference }),
  Schema.Struct({
    type: Schema.Literal("commit"),
    sha: TrimmedNonEmptyString.check(Schema.isPattern(/^[a-fA-F0-9]{7,64}$/)),
  }),
  Schema.Struct({
    type: Schema.Literal("custom"),
    instructions: TrimmedNonEmptyString.check(Schema.isMaxLength(16_000)),
  }),
]);
export type CodexReviewTarget = typeof CodexReviewTarget.Type;
