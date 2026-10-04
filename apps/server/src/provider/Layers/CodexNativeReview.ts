import { CodexReviewTarget } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexSchema from "effect-codex-app-server/schema";

const decodeReviewTarget = Schema.decodeUnknownEffect(CodexReviewTarget);
const decodeReviewResponse = Schema.decodeUnknownEffect(CodexSchema.V2ReviewStartResponse);

/** Validation precedes reservation/I/O. Do not let an untyped daemon caller
 * select deprecated detached delivery or smuggle an alternate native thread. */
export const codexNativeReviewParams = (threadId: string, target: unknown) =>
  decodeReviewTarget(target).pipe(
    Effect.map((target): CodexSchema.V2ReviewStartParams => ({
      threadId,
      delivery: "inline",
      target,
    })),
    Effect.mapError(() =>
      CodexErrors.CodexAppServerRequestError.invalidRequest("Invalid native review target."),
    ),
  );

/** A valid response can acknowledge work but cannot complete it. In particular,
 * an unexpected detached identity must never be adopted as this chat's cursor. */
export const decodeCodexNativeReviewResponse = (threadId: string, response: unknown) =>
  decodeReviewResponse(response).pipe(
    Effect.mapError(() =>
      CodexErrors.CodexAppServerRequestError.invalidRequest(
        "Codex returned an invalid native review acknowledgement; do not resend automatically.",
      ),
    ),
    Effect.flatMap((value) =>
      value.reviewThreadId === threadId
        ? Effect.succeed(value)
        : Effect.fail(
            CodexErrors.CodexAppServerRequestError.invalidRequest(
              "Codex acknowledged a different review thread; do not resend automatically.",
            ),
          ),
    ),
  );
