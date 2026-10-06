import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { it as effectIt } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import {
  CODEX_HISTORY_RECOVERY_REQUIRED_MESSAGE,
  isCodexHistoryRecoveryRequiredError,
} from "@cafecode/shared/codexHistorySafety";
import {
  codexHistoryFailureBelongsToRoot,
  isCodexOversizedHistoryArgumentsError,
  makeCodexHistorySafety,
  normalizeCodexBlockedHistoryNotification,
} from "./codexHistorySafety.ts";

const errorJson = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    error: {
      type: "invalid_request_error",
      code: "string_above_max_length",
      param: "input[169].arguments",
      message: "Synthetic error with PRIVATE_VALUE that must never become guidance",
      ...overrides,
    },
  });

describe("Codex provider-history failure classification", () => {
  it("recognizes only the bounded structured API rejection for tool arguments", () => {
    assert.equal(isCodexOversizedHistoryArgumentsError(errorJson()), true);
    for (const message of [
      undefined,
      null,
      { error: { code: "string_above_max_length", param: "input[0].arguments" } },
      '{"detail":"Bad Request"}',
      "Invalid 'input[169].arguments': string too long",
      `Unexpected status 400: ${errorJson()}`,
      errorJson({ type: "authentication_error" }),
      errorJson({ code: "rate_limit_exceeded" }),
      errorJson({ param: "input[169].content" }),
      errorJson({ param: "tools[169].arguments" }),
      errorJson({ param: "input[-1].arguments" }),
      errorJson({ param: "input[0].arguments.extra" }),
      errorJson({ param: "input[12345678901].arguments" }),
      errorJson({ message: "x".repeat(16_384) }),
      "[".repeat(16_385),
    ]) {
      assert.equal(isCodexOversizedHistoryArgumentsError(message), false);
    }
  });

  it("does not grant recovery action authority to provider prose or an arbitrary banner", () => {
    assert.equal(
      isCodexHistoryRecoveryRequiredError(CODEX_HISTORY_RECOVERY_REQUIRED_MESSAGE),
      true,
    );
    assert.equal(isCodexHistoryRecoveryRequiredError(errorJson()), false);
    assert.equal(
      isCodexHistoryRecoveryRequiredError(`${CODEX_HISTORY_RECOVERY_REQUIRED_MESSAGE} `),
      false,
    );
    assert.equal(isCodexHistoryRecoveryRequiredError("Bad Request"), false);
  });

  it("requires exact root and latest native turn, including the paired terminal event", () => {
    const error = {
      method: "error",
      params: {
        threadId: "root",
        turnId: "latest",
        willRetry: false,
        error: { message: errorJson() },
      },
    };
    assert.equal(codexHistoryFailureBelongsToRoot(error, "root", "latest"), true);
    for (const [root, latest] of [
      ["child", "latest"],
      ["root", "older"],
      [undefined, "latest"],
      ["root", undefined],
    ]) {
      assert.equal(codexHistoryFailureBelongsToRoot(error, root, latest), false);
    }
    assert.equal(
      codexHistoryFailureBelongsToRoot({ ...error, method: "item/completed" }, "root", "latest"),
      false,
    );
    assert.equal(
      codexHistoryFailureBelongsToRoot(
        { ...error, params: { ...error.params, willRetry: true } },
        "root",
        "latest",
      ),
      false,
    );
    const terminal = {
      method: "turn/completed",
      params: {
        threadId: "root",
        turn: { id: "latest", status: "failed", error: { message: errorJson() } },
      },
    };
    assert.equal(codexHistoryFailureBelongsToRoot(terminal, "root", "latest"), true);
    assert.equal(
      codexHistoryFailureBelongsToRoot(
        {
          ...terminal,
          params: { ...terminal.params, turn: { ...terminal.params.turn, status: "completed" } },
        },
        "root",
        "latest",
      ),
      false,
    );
  });

  it("normalizes root failures without leaking diagnostic content or changing lifecycle identity", () => {
    for (const message of [errorJson(), '{"detail":"Bad Request"}']) {
      const error = {
        method: "error",
        params: {
          threadId: "root",
          turnId: "turn",
          willRetry: false,
          error: { message, additionalDetails: "PRIVATE_VALUE" },
        },
      };
      const normalized = normalizeCodexBlockedHistoryNotification(error, "root");
      assert.equal(normalized.params.threadId, "root");
      assert.equal(normalized.params.turnId, "turn");
      assert.equal(normalized.params.error.message, CODEX_HISTORY_RECOVERY_REQUIRED_MESSAGE);
      assert.doesNotMatch(JSON.stringify(normalized), /PRIVATE_VALUE/);
      assert.equal(normalizeCodexBlockedHistoryNotification(error, "different-root"), error);
      const terminal = {
        method: "turn/completed",
        params: {
          threadId: "root",
          turn: { id: "turn", status: "failed", items: [], error: { message } },
        },
      };
      const normalizedTerminal = normalizeCodexBlockedHistoryNotification(terminal, "root");
      assert.equal(
        normalizedTerminal.params.turn.error.message,
        CODEX_HISTORY_RECOVERY_REQUIRED_MESSAGE,
      );
      assert.equal(normalizedTerminal.params.turn.status, "failed");
      assert.equal(normalizedTerminal.params.turn.id, "turn");
      const success = {
        ...terminal,
        params: { ...terminal.params, turn: { ...terminal.params.turn, status: "completed" } },
      };
      assert.equal(normalizeCodexBlockedHistoryNotification(success, "root"), success);
    }
  });
});

effectIt.effect(
  "fences immediately before slow durable publication and deduplicates paired errors",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let writes = 0;
      const guard = yield* makeCodexHistorySafety({
        isBlocked: () => Effect.succeed(false),
        markBlocked: () =>
          Effect.gen(function* () {
            writes += 1;
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }),
      });
      const marking = yield* guard.markBlocked("native-root").pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      assert.equal(yield* guard.isBlocked("native-root"), true);
      assert.equal(yield* guard.isBlocked("different-root"), false);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(marking);
      yield* guard.markBlocked("native-root");
      assert.equal(writes, 1);
    }),
);

effectIt.effect("keeps a concurrent local fence when an earlier durable read returns clear", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const guard = yield* makeCodexHistorySafety({
      isBlocked: () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(false),
        ),
      markBlocked: () => Effect.void,
    });
    const checking = yield* guard.isBlocked("native-root").pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    yield* guard.blockLocally("native-root");
    yield* Deferred.succeed(release, undefined);
    assert.equal(yield* Fiber.join(checking), true);
  }),
);

effectIt.effect(
  "does not mistake unavailable persistence for a clear guard or lose a local failure",
  () =>
    Effect.gen(function* () {
      const guard = yield* makeCodexHistorySafety({
        isBlocked: () => Effect.fail("unavailable"),
        markBlocked: () => Effect.fail("unavailable"),
      });
      assert.equal(yield* guard.isBlocked("native-root").pipe(Effect.flip), "unavailable");
      assert.equal(yield* guard.markBlocked("native-root").pipe(Effect.flip), "unavailable");
      assert.equal(yield* guard.isBlocked("native-root"), true);
      const resumed = yield* makeCodexHistorySafety({
        isBlocked: (id) => Effect.succeed(id === "native-root"),
        markBlocked: () => Effect.void,
      });
      assert.equal(yield* resumed.isBlocked("native-root"), true);
      assert.equal(yield* resumed.knownBlocked("native-root"), true);
      assert.equal(yield* resumed.isBlocked("new-context"), false);
    }),
);
