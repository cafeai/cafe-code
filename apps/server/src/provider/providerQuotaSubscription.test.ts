import { describe, assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderSession,
  type ProviderSessionQuotaResult,
} from "@cafecode/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  readBoundProviderQuota,
  subscribeProviderQuota,
  UNAVAILABLE_SESSION_QUOTA,
  unavailableProviderQuotaStream,
  type ProviderQuotaAuthority,
} from "./providerQuotaSubscription.ts";

const input = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  session: {
    threadId: ThreadId.make("chat"),
    runtimeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  },
};
const report = {
  source: "claude-session" as const,
  observedAt: "2026-10-09T00:00:00.000Z",
  meters: [],
};
const available: ProviderSessionQuotaResult = { report };
const session: ProviderSession = {
  threadId: input.session.threadId,
  provider: ProviderDriverKind.make("claudeAgent"),
  providerInstanceId: input.instanceId,
  subagentRuntimeId: input.session.runtimeId,
  cwd: "saved-workspace",
  status: "ready",
  runtimeMode: "full-access",
  createdAt: report.observedAt,
  updatedAt: report.observedAt,
  quotaReport: report,
  commandCatalogConfigurationKey: "a".repeat(64),
};
const authority: ProviderQuotaAuthority = {
  configuration: session.commandCatalogConfigurationKey!,
  snapshotSequence: 1,
  sessions: [{ ...input.session, cwd: session.cwd! }],
};

describe("passive session quota subscriptions", () => {
  it.effect("holds one denied null without work or completion until the consumer cancels", () =>
    Effect.gen(function* () {
      const initial = yield* Deferred.make<void>();
      const finished = yield* Deferred.make<void>();
      const values: ProviderSessionQuotaResult[] = [];
      const receiver = yield* unavailableProviderQuotaStream().pipe(
        Stream.ensuring(Deferred.succeed(finished, undefined)),
        Stream.runForEach((value) =>
          Effect.gen(function* () {
            values.push(value);
            yield* Deferred.succeed(initial, undefined);
          }),
        ),
        Effect.forkScoped,
      );
      yield* Deferred.await(initial);
      yield* TestClock.adjust(10_000);
      assert.deepEqual(values, [UNAVAILABLE_SESSION_QUOTA]);
      assert.equal(yield* Deferred.isDone(finished), false);
      yield* Fiber.interrupt(receiver);
      assert.equal(yield* Deferred.isDone(finished), true);
      assert.deepEqual(values, [UNAVAILABLE_SESSION_QUOTA]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "admits only a singular current query/configuration/workspace of the exact instance",
    () =>
      Effect.gen(function* () {
        assert.deepEqual(
          yield* readBoundProviderQuota(
            input,
            Effect.succeed(authority),
            Effect.succeed([session]),
          ),
          available,
        );
        for (const invalid of [
          { ...session, providerInstanceId: ProviderInstanceId.make("other") },
          { ...session, provider: ProviderDriverKind.make("codex") },
          { ...session, subagentRuntimeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
          { ...session, cwd: "other-workspace" },
          { ...session, commandCatalogConfigurationKey: "b".repeat(64) },
          { ...session, status: "closed" as const },
          { ...session, status: "error" as const },
          { ...session, quotaReport: undefined },
        ])
          assert.deepEqual(
            yield* readBoundProviderQuota(
              input,
              Effect.succeed(authority),
              Effect.succeed([invalid]),
            ),
            UNAVAILABLE_SESSION_QUOTA,
          );
        assert.deepEqual(
          yield* readBoundProviderQuota(
            input,
            Effect.succeed(authority),
            Effect.succeed([session, session]),
          ),
          UNAVAILABLE_SESSION_QUOTA,
        );
        assert.deepEqual(
          yield* readBoundProviderQuota(
            input,
            Effect.succeed(undefined),
            Effect.die("must not read"),
          ),
          UNAVAILABLE_SESSION_QUOTA,
        );
        assert.deepEqual(
          yield* readBoundProviderQuota(
            input,
            Effect.succeed({
              ...authority,
              sessions: [...authority.sessions, ...authority.sessions],
            }),
            Effect.die("ambiguous authority must not read"),
          ),
          UNAVAILABLE_SESSION_QUOTA,
        );
      }),
  );

  it.effect(
    "selects Settings' newest eligible observation without borrowing a different query",
    () =>
      Effect.gen(function* () {
        const newer = {
          ...session,
          threadId: ThreadId.make("second"),
          subagentRuntimeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          quotaReport: { ...report, observedAt: "2026-10-09T00:01:00.000Z", meters: null },
        };
        const multiple = {
          ...authority,
          sessions: [
            ...authority.sessions,
            { threadId: newer.threadId, runtimeId: newer.subagentRuntimeId, cwd: session.cwd! },
          ],
        };
        assert.deepEqual(
          yield* readBoundProviderQuota(
            { instanceId: input.instanceId },
            Effect.succeed(multiple),
            Effect.succeed([session, newer]),
          ),
          { report: newer.quotaReport },
        );
        assert.deepEqual(
          yield* readBoundProviderQuota(
            input,
            Effect.succeed(multiple),
            Effect.succeed([session, newer]),
          ),
          available,
        );
        assert.deepEqual(
          yield* readBoundProviderQuota(
            { instanceId: input.instanceId },
            Effect.succeed(authority),
            Effect.succeed([newer]),
          ),
          UNAVAILABLE_SESSION_QUOTA,
        );
      }),
  );

  it.effect(
    "preserves a report while unrelated projection progress leaves exact authority unchanged",
    () =>
      Effect.gen(function* () {
        let current = authority;
        assert.deepEqual(
          yield* readBoundProviderQuota(
            input,
            Effect.sync(() => current),
            Effect.sync(() => {
              current = { ...authority, snapshotSequence: authority.snapshotSequence + 1 };
              return [session];
            }),
          ),
          available,
        );
      }),
  );

  it.effect("discards inventory after configuration, workspace or runtime replacement", () =>
    Effect.gen(function* () {
      for (const replacement of [
        { ...authority, configuration: "b".repeat(64) },
        { ...authority, sessions: [{ ...authority.sessions[0]!, cwd: "moved" }] },
        {
          ...authority,
          sessions: [
            { ...authority.sessions[0]!, runtimeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
          ],
        },
        { ...authority, sessions: [] },
      ]) {
        let current = authority;
        assert.deepEqual(
          yield* readBoundProviderQuota(
            input,
            Effect.sync(() => current),
            Effect.sync(() => {
              current = replacement;
              return [session];
            }),
          ),
          UNAVAILABLE_SESSION_QUOTA,
        );
      }
    }),
  );

  it.effect("fences an in-flight invalidation and coalesces a burst into one trailing read", () =>
    Effect.gen(function* () {
      const changes = yield* PubSub.unbounded<void>();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const settled = yield* Deferred.make<void>();
      const values: ProviderSessionQuotaResult[] = [];
      let reads = 0;
      const read = Effect.gen(function* () {
        if (++reads === 1) {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
        }
        return available;
      });
      yield* subscribeProviderQuota(read, [Stream.fromPubSub(changes)]).pipe(
        Stream.runForEach((value) =>
          Effect.gen(function* () {
            values.push(value);
            if (values.length === 2) yield* Deferred.succeed(settled, undefined);
          }),
        ),
        Effect.forkScoped,
      );
      yield* Deferred.await(entered);
      for (let count = 0; count < 30; count++) yield* PubSub.publish(changes, undefined);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(settled);
      assert.equal(reads, 2);
      assert.deepEqual(values, [UNAVAILABLE_SESSION_QUOTA, available]);
    }).pipe(Effect.scoped),
  );

  it.effect("retires only the subscriber when its consumer leaves", () =>
    Effect.gen(function* () {
      const changes = yield* PubSub.unbounded<void>();
      let reads = 0;
      yield* Effect.scoped(
        subscribeProviderQuota(
          Effect.sync(() => {
            reads++;
            return available;
          }),
          [Stream.fromPubSub(changes)],
        ).pipe(Stream.take(1), Stream.runDrain),
      );
      yield* PubSub.publish(changes, undefined);
      yield* Effect.yieldNow;
      assert.equal(reads, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("bounds a stalled inventory and allows content-free notification recovery", () =>
    Effect.gen(function* () {
      const changes = yield* PubSub.unbounded<void>();
      const entered = yield* Deferred.make<void>();
      const failed = yield* Deferred.make<void>();
      const recovered = yield* Deferred.make<void>();
      const values: ProviderSessionQuotaResult[] = [];
      let reads = 0;
      yield* subscribeProviderQuota(
        Effect.suspend(() =>
          ++reads === 1
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.succeed(available),
        ),
        [Stream.fromPubSub(changes)],
      ).pipe(
        Stream.runForEach((value) =>
          Effect.gen(function* () {
            values.push(value);
            yield* Deferred.succeed(value.report === null ? failed : recovered, undefined);
          }),
        ),
        Effect.forkScoped,
      );
      yield* Deferred.await(entered);
      yield* TestClock.adjust(5_000);
      yield* Deferred.await(failed);
      yield* PubSub.publish(changes, undefined);
      yield* Deferred.await(recovered);
      assert.deepEqual(values, [UNAVAILABLE_SESSION_QUOTA, available]);
    }).pipe(Effect.scoped),
  );
});
