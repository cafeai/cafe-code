import { describe, expect, it } from "vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  SubagentRuntimeId,
  ThreadId,
  type ProviderSession,
  type ProviderSubagentPolicySession,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import { matchesSubagentPolicySession } from "./subagentPolicyContinuation.ts";
import {
  admitCodexTurnStartLifecycleBoundary,
  assertCodexSubagentPolicySessionBoundary,
} from "./Layers/CodexSessionRuntime.ts";

const expected: ProviderSubagentPolicySession = {
  threadId: ThreadId.make("synthetic-policy-session"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  subagentRuntimeId: SubagentRuntimeId.make("00000000-0000-4000-8000-000000000016"),
  maxConcurrentSubagents: 16,
};
const session: ProviderSession = {
  provider: ProviderDriverKind.make("codex"),
  ...expected,
  status: "ready",
  runtimeMode: "full-access",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const mutations: ReadonlyArray<readonly [string, Partial<ProviderSession>]> = [
  ["thread", { threadId: ThreadId.make("other-thread") }],
  ["instance", { providerInstanceId: ProviderInstanceId.make("other-account") }],
  [
    "generation",
    { subagentRuntimeId: SubagentRuntimeId.make("00000000-0000-4000-8000-000000000017") },
  ],
  ["missing generation", { subagentRuntimeId: undefined }],
  ["policy", { maxConcurrentSubagents: 17 }],
  ["unknown policy", { maxConcurrentSubagents: undefined }],
  ["inherited policy", { maxConcurrentSubagents: null }],
  ["driver", { provider: ProviderDriverKind.make("claudeAgent") }],
  ["closed", { status: "closed" }],
  ["error", { status: "error" }],
  ["connecting", { status: "connecting" }],
];

describe("exact existing subagent policy continuation", () => {
  it("matches only the already materialized policy in the exact ready/running Codex process", () => {
    expect(matchesSubagentPolicySession(session, expected)).toBe(true);
    expect(matchesSubagentPolicySession({ ...session, status: "running" }, expected)).toBe(true);
    expect(matchesSubagentPolicySession(undefined, expected)).toBe(false);
  });
  it.each(mutations)(
    "rejects a changed %s before native start reservation or steer",
    async (_name, mutation) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const semaphore = yield* Semaphore.make(1);
          const sessionRef = yield* Ref.make({ ...session, ...mutation });
          const closedRef = yield* Ref.make(false);
          const nativeTurnStartPendingRef = yield* Ref.make(false);
          const nativeTurnStartRequestRef = yield* Ref.make<symbol | undefined>(undefined);
          const start = yield* Effect.exit(
            admitCodexTurnStartLifecycleBoundary({
              semaphore,
              sessionRef,
              closedRef,
              nativeTurnStartPendingRef,
              nativeTurnStartRequestRef,
              completionsRef: yield* Ref.make(new Map()),
              rootLifecycleEpochRef: yield* Ref.make(Symbol()),
              manualCompactionPendingRef: yield* Ref.make(false),
              expectedSubagentPolicySession: expected,
            }),
          );
          const steer = yield* Effect.exit(
            assertCodexSubagentPolicySessionBoundary({
              semaphore,
              sessionRef,
              closedRef,
              expected,
            }),
          );
          expect(Exit.isFailure(start)).toBe(true);
          expect(Exit.isFailure(steer)).toBe(true);
          expect(yield* Ref.get(nativeTurnStartPendingRef)).toBe(false);
          expect(yield* Ref.get(nativeTurnStartRequestRef)).toBeUndefined();
        }),
      );
    },
  );
  it("accepts the same native tuple for start/steer and refuses a native closed fence", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const semaphore = yield* Semaphore.make(1);
        const sessionRef = yield* Ref.make(session);
        const closedRef = yield* Ref.make(false);
        yield* assertCodexSubagentPolicySessionBoundary({
          semaphore,
          sessionRef,
          closedRef,
          expected,
        });
        const nativeTurnStartPendingRef = yield* Ref.make(false);
        yield* admitCodexTurnStartLifecycleBoundary({
          semaphore,
          sessionRef,
          closedRef,
          nativeTurnStartPendingRef,
          nativeTurnStartRequestRef: yield* Ref.make<symbol | undefined>(undefined),
          completionsRef: yield* Ref.make(new Map()),
          rootLifecycleEpochRef: yield* Ref.make(Symbol()),
          manualCompactionPendingRef: yield* Ref.make(false),
          expectedSubagentPolicySession: expected,
        });
        expect(yield* Ref.get(nativeTurnStartPendingRef)).toBe(true);
        yield* Ref.set(closedRef, true);
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              assertCodexSubagentPolicySessionBoundary({
                semaphore,
                sessionRef,
                closedRef,
                expected,
              }),
            ),
          ),
        ).toBe(true);
      }),
    );
  });
  it("rechecks the runtime generation after waiting for the native lifecycle permit", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const semaphore = yield* Semaphore.make(0);
          const sessionRef = yield* Ref.make(session);
          const closedRef = yield* Ref.make(false);
          const fiber = yield* Effect.forkChild(
            Effect.exit(
              assertCodexSubagentPolicySessionBoundary({
                semaphore,
                sessionRef,
                closedRef,
                expected,
              }),
            ),
          );
          yield* Ref.set(sessionRef, {
            ...session,
            subagentRuntimeId: SubagentRuntimeId.make("00000000-0000-4000-8000-000000000017"),
          });
          yield* semaphore.release(1);
          expect(Exit.isFailure(yield* Fiber.join(fiber))).toBe(true);
        }),
      ),
    );
  });
});
