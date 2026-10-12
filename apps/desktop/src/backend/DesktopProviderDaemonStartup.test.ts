import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { ProviderDaemonHealth } from "@cafecode/contracts";
import { makeProviderDaemonStartupProgressTracker } from "@cafecode/shared/backendStartupProgress";

import {
  stopOwnedProviderDaemonChild,
  waitForOwnedProviderDaemonHealth,
} from "./DesktopProviderDaemonManager.ts";

function ownedChild(
  isRunning: ChildProcessSpawner.ChildProcessHandle["isRunning"],
  kill: ChildProcessSpawner.ChildProcessHandle["kill"],
): ChildProcessSpawner.ChildProcessHandle {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: Effect.never,
    isRunning,
    kill,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
}

const endpoint = { httpBaseUrl: "http://127.0.0.1:1", token: "synthetic-test-token" };
const health: ProviderDaemonHealth = {
  ok: true,
  mode: "provider-daemon",
  pid: 123,
  ppid: 1,
  version: "fixture",
  protocolVersion: 1,
  startedAt: "1970-01-01T00:00:00.000Z",
  activeSessionCount: 0,
  configuredInstanceCount: 0,
  eventCursor: 0,
};
const bytes = (value: string) => new TextEncoder().encode(value);

describe("owned provider daemon startup", () => {
  it.effect("bounds the actual exit wait and escalates only the same owned handle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const signals: string[] = [];
        let running = true;
        const handle = ownedChild(
          Effect.sync(() => running),
          (options) => {
            signals.push(options?.killSignal ?? "SIGTERM");
            if (options?.killSignal === "SIGKILL") running = false;
            // Signal delivery succeeded, but TERM never produces an exit event.
            return options?.killSignal === "SIGTERM" ? Effect.never : Effect.void;
          },
        );
        const stopped = yield* stopOwnedProviderDaemonChild(handle).pipe(Effect.forkScoped);
        yield* TestClock.adjust(Duration.seconds(14));
        assert.deepEqual(signals, ["SIGTERM"]);
        yield* TestClock.adjust(Duration.seconds(1));
        assert.isTrue(yield* Fiber.join(stopped));
        assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
      }),
    ),
  );

  it.effect("returns unconfirmed within eighteen seconds if neither signal yields an exit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const signals: string[] = [];
        const handle = ownedChild(Effect.succeed(true), (options) => {
          signals.push(options?.killSignal ?? "SIGTERM");
          return Effect.never;
        });
        const stopped = yield* stopOwnedProviderDaemonChild(handle).pipe(Effect.forkScoped);
        yield* TestClock.adjust(Duration.seconds(18));
        assert.isFalse(yield* Fiber.join(stopped));
        assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
      }),
    ),
  );

  it.effect("does not signal an already-exited handle", () =>
    Effect.gen(function* () {
      let calls = 0;
      const handle = ownedChild(Effect.succeed(false), () =>
        Effect.sync(() => {
          calls += 1;
        }),
      );
      assert.isTrue(yield* stopOwnedProviderDaemonChild(handle));
      assert.equal(calls, 0);
    }),
  );

  it.effect("retains the ordinary thirty-second budget without exact migration progress", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeNanos;
        const elapsedMs = Clock.currentTimeNanos.pipe(
          Effect.map((now) => Number(now - startedAt) / 1_000_000),
        );
        const tracker = makeProviderDaemonStartupProgressTracker(30_000);
        const child = ownedChild(Effect.succeed(true), () => Effect.void);
        const result = yield* waitForOwnedProviderDaemonHealth(
          endpoint,
          tracker,
          elapsedMs,
          child,
          () => new Promise(() => {}),
        ).pipe(Effect.exit, Effect.forkScoped);
        yield* TestClock.adjust(Duration.seconds(30));
        assert.isTrue((yield* Fiber.join(result))._tag === "Failure");
        assert.equal(tracker.deadlineMs, 30_000);
      }),
    ),
  );

  it.effect("permits validated migration work beyond ordinary startup and restores readiness", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeNanos;
        const elapsedMs = Clock.currentTimeNanos.pipe(
          Effect.map((now) => Number(now - startedAt) / 1_000_000),
        );
        const tracker = makeProviderDaemonStartupProgressTracker(30_000);
        tracker.push(bytes("cafe-migration:v1:start:92\n"), 0);
        const ready = yield* Deferred.make<void>();
        const child = ownedChild(Effect.succeed(true), () => Effect.void);
        const result = yield* waitForOwnedProviderDaemonHealth(
          endpoint,
          tracker,
          elapsedMs,
          child,
          () => Effect.runPromise(Deferred.await(ready).pipe(Effect.as(health))),
        ).pipe(Effect.forkScoped);
        yield* TestClock.adjust(Duration.seconds(120));
        tracker.push(bytes("cafe-migration:v1:complete:92\n"), 120_000);
        yield* Deferred.succeed(ready, undefined);
        assert.deepEqual(yield* Fiber.join(result), health);
        assert.equal(tracker.deadlineMs, 150_000);
      }),
    ),
  );

  it.effect("cannot renew the absolute sixty-minute migration deadline", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeNanos;
        const elapsedMs = Clock.currentTimeNanos.pipe(
          Effect.map((now) => Number(now - startedAt) / 1_000_000),
        );
        const tracker = makeProviderDaemonStartupProgressTracker(30_000);
        tracker.push(bytes("cafe-migration:v1:start:92\n"), 0);
        const child = ownedChild(Effect.succeed(true), () => Effect.void);
        const result = yield* waitForOwnedProviderDaemonHealth(
          endpoint,
          tracker,
          elapsedMs,
          child,
          () => new Promise(() => {}),
        ).pipe(Effect.exit, Effect.forkScoped);
        yield* TestClock.adjust(Duration.seconds(3_599));
        tracker.push(bytes("cafe-migration:v1:start:92\n"), 3_599_000);
        yield* TestClock.adjust(Duration.seconds(1));
        assert.equal(tracker.deadlineMs, 3_600_000);
        assert.isTrue((yield* Fiber.join(result))._tag === "Failure");
      }),
    ),
  );
});
