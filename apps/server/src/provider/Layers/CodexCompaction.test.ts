import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import { ProviderDriverKind, type ProviderSession, ThreadId } from "@cafecode/contracts";
import * as CodexErrors from "effect-codex-app-server/errors";
import { requestCodexManualCompaction } from "./CodexSessionRuntime.ts";

const setup = Effect.gen(function* () {
  return {
    sessionRef: yield* Ref.make<ProviderSession>({
      provider: ProviderDriverKind.make("codex"),
      threadId: ThreadId.make("cafe-thread"),
      status: "ready",
      runtimeMode: "full-access",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
    pendingRef: yield* Ref.make(false),
    lifecycleEpochRef: yield* Ref.make(Symbol()),
  };
});

it.effect("reserves compaction admission before I/O and leaves completion to native events", () =>
  Effect.gen(function* () {
    const state = yield* setup;
    let calls = 0;
    const request = () =>
      Effect.gen(function* () {
        calls++;
        assert.equal((yield* Ref.get(state.sessionRef)).status, "running");
        assert.equal(yield* Ref.get(state.pendingRef), true);
        return {};
      });
    yield* requestCodexManualCompaction({ ...state, request });
    assert.equal((yield* Ref.get(state.sessionRef)).activeTurnId, undefined);
    assert.equal(
      Exit.isFailure(yield* Effect.exit(requestCodexManualCompaction({ ...state, request }))),
      true,
    );
    assert.equal(calls, 1);
  }),
);

it.effect("does not resurrect compaction when native completion beats the ACK", () =>
  Effect.gen(function* () {
    const state = yield* setup;
    yield* requestCodexManualCompaction({
      ...state,
      request: () =>
        Effect.gen(function* () {
          yield* Ref.set(state.lifecycleEpochRef, Symbol());
          yield* Ref.set(state.pendingRef, false);
          yield* Ref.update(state.sessionRef, (session) => ({
            ...session,
            status: "ready" as const,
          }));
          return {};
        }),
    });
    assert.equal((yield* Ref.get(state.sessionRef)).status, "ready");
    assert.equal(yield* Ref.get(state.pendingRef), false);
  }),
);

it.effect("releases admission on a conclusive native rejection", () =>
  Effect.gen(function* () {
    const state = yield* setup;
    const result = yield* Effect.exit(
      requestCodexManualCompaction({
        ...state,
        request: () =>
          Effect.fail(CodexErrors.CodexAppServerRequestError.invalidRequest("unsupported method")),
      }),
    );
    assert.equal(Exit.isFailure(result), true);
    assert.equal((yield* Ref.get(state.sessionRef)).status, "ready");
    assert.equal(yield* Ref.get(state.pendingRef), false);
  }),
);

it.effect("keeps uncertain transport failures closed to duplicate compaction", () =>
  Effect.gen(function* () {
    const state = yield* setup;
    yield* Effect.exit(
      requestCodexManualCompaction({
        ...state,
        request: () =>
          Effect.fail(
            new CodexErrors.CodexAppServerTransportError({
              detail: "connection lost",
              cause: null,
            }),
          ),
      }),
    );
    assert.equal((yield* Ref.get(state.sessionRef)).status, "error");
    assert.equal(yield* Ref.get(state.pendingRef), true);
  }),
);
