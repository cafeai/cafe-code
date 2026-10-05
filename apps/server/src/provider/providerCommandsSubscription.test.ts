import { describe, assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderCommandCatalog,
  type ProviderSession,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  readBoundProviderCommands,
  subscribeProviderCommands,
} from "./providerCommandsSubscription.ts";

const input = {
  threadId: ThreadId.make("chat"),
  instanceId: ProviderInstanceId.make("claudeAgent"),
  runtimeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};
const available: ProviderCommandCatalog = { status: "available", commands: [{ name: "safe" }] };
const session: ProviderSession = {
  threadId: input.threadId,
  provider: ProviderDriverKind.make("claudeAgent"),
  providerInstanceId: input.instanceId,
  subagentRuntimeId: input.runtimeId,
  cwd: "saved-workspace",
  status: "ready",
  runtimeMode: "full-access",
  createdAt: "2026-10-05T00:00:00.000Z",
  updatedAt: "2026-10-05T00:00:00.000Z",
  commandCatalog: available,
  commandCatalogConfigurationKey: "a".repeat(64),
};
const authority = { cwd: session.cwd!, configuration: session.commandCatalogConfigurationKey! };
const unavailable: ProviderCommandCatalog = { status: "unavailable", commands: [] };
describe("exact-session command catalog subscriptions", () => {
  it.effect(
    "admits only the exact current account/query/cwd/configuration and singular session",
    () =>
      Effect.gen(function* () {
        assert.deepEqual(
          yield* readBoundProviderCommands(
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
        ])
          assert.deepEqual(
            yield* readBoundProviderCommands(
              input,
              Effect.succeed(authority),
              Effect.succeed([invalid]),
            ),
            unavailable,
          );
        assert.deepEqual(
          yield* readBoundProviderCommands(
            input,
            Effect.succeed(authority),
            Effect.succeed([session, session]),
          ),
          unavailable,
        );
        assert.deepEqual(
          yield* readBoundProviderCommands(
            input,
            Effect.succeed(undefined),
            Effect.die("must not read"),
          ),
          unavailable,
        );
      }),
  );
  it.effect("discards a slow inventory result after either project or account replacement", () =>
    Effect.gen(function* () {
      for (const replacement of [
        { ...authority, cwd: "moved" },
        { ...authority, configuration: "b".repeat(64) },
      ]) {
        let current = authority;
        const result = yield* readBoundProviderCommands(
          input,
          Effect.sync(() => current),
          Effect.sync(() => {
            current = replacement;
            return [session];
          }),
        );
        assert.deepEqual(result, unavailable);
      }
    }),
  );
  it.effect(
    "subscribes before its first read and coalesces a burst into one trailing replacement",
    () =>
      Effect.gen(function* () {
        const changes = yield* PubSub.unbounded<void>();
        const release = yield* Deferred.make<void>();
        const entered = yield* Deferred.make<void>();
        const settled = yield* Deferred.make<void>();
        const results: ProviderCommandCatalog[] = [];
        let reads = 0;
        const read = Effect.gen(function* () {
          reads++;
          if (reads === 1) {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return available;
          }
          return { status: "empty" as const, commands: [] };
        });
        yield* subscribeProviderCommands(read, [Stream.fromPubSub(changes)]).pipe(
          Stream.runForEach((value) =>
            Effect.gen(function* () {
              results.push(value);
              if (results.length === 2) yield* Deferred.succeed(settled, undefined);
            }),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(entered);
        for (let n = 0; n < 30; n++) yield* PubSub.publish(changes, undefined);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(release, undefined);
        yield* Deferred.await(settled);
        assert.equal(reads, 2);
        assert.deepEqual(results, [available, { status: "empty", commands: [] }]);
      }).pipe(Effect.scoped),
  );
  it.effect("bounds a stalled snapshot and lets a later notification recover", () =>
    Effect.gen(function* () {
      const changes = yield* PubSub.unbounded<void>();
      const entered = yield* Deferred.make<void>();
      const failed = yield* Deferred.make<void>();
      const recovered = yield* Deferred.make<void>();
      let reads = 0;
      const values: ProviderCommandCatalog[] = [];
      yield* subscribeProviderCommands(
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
            yield* Deferred.succeed(value.status === "unavailable" ? failed : recovered, undefined);
          }),
        ),
        Effect.forkScoped,
      );
      yield* Deferred.await(entered);
      yield* TestClock.adjust(5_000);
      yield* Deferred.await(failed);
      yield* PubSub.publish(changes, undefined);
      yield* Deferred.await(recovered);
      assert.deepEqual(values, [unavailable, available]);
    }).pipe(Effect.scoped),
  );
});
