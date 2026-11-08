import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";

import * as ElectronPowerSaveBlocker from "../electron/ElectronPowerSaveBlocker.ts";
import * as DesktopPowerSaveBlocker from "./DesktopPowerSaveBlocker.ts";

interface FakePowerSaveBlocker {
  readonly starts: Ref.Ref<readonly ElectronPowerSaveBlocker.ElectronPowerSaveBlockerType[]>;
  readonly stops: Ref.Ref<readonly number[]>;
  readonly activeIds: Ref.Ref<ReadonlySet<number>>;
  readonly layer: Layer.Layer<ElectronPowerSaveBlocker.ElectronPowerSaveBlocker>;
}

const makeFakePowerSaveBlockerWith = (
  options: {
    readonly beforeStart?: (
      type: ElectronPowerSaveBlocker.ElectronPowerSaveBlockerType,
    ) => Effect.Effect<void>;
    readonly beforeStop?: (id: number) => Effect.Effect<void>;
    readonly refuseStop?: (id: number) => boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const starts = yield* Ref.make<
      readonly ElectronPowerSaveBlocker.ElectronPowerSaveBlockerType[]
    >([]);
    const stops = yield* Ref.make<readonly number[]>([]);
    const activeIds = yield* Ref.make<ReadonlySet<number>>(new Set());
    const nextId = yield* Ref.make(1);

    const layer = Layer.succeed(ElectronPowerSaveBlocker.ElectronPowerSaveBlocker, {
      start: (type) =>
        Effect.gen(function* () {
          if (options.beforeStart) yield* options.beforeStart(type);
          const id = yield* Ref.getAndUpdate(nextId, (value) => value + 1);
          yield* Ref.update(starts, (values) => [...values, type]);
          yield* Ref.update(activeIds, (values) => new Set(values).add(id));
          return id;
        }),
      stop: (id) =>
        Effect.gen(function* () {
          if (options.beforeStop) yield* options.beforeStop(id);
          yield* Ref.update(stops, (values) => [...values, id]);
          if (options.refuseStop?.(id)) return;
          yield* Ref.update(activeIds, (values) => {
            const next = new Set(values);
            next.delete(id);
            return next;
          });
        }),
      isStarted: (id) => Ref.get(activeIds).pipe(Effect.map((values) => values.has(id))),
    } satisfies ElectronPowerSaveBlocker.ElectronPowerSaveBlockerShape);

    return {
      starts,
      stops,
      activeIds,
      layer,
    };
  });
const makeFakePowerSaveBlocker = makeFakePowerSaveBlockerWith();

const makeLayer = (fake: FakePowerSaveBlocker) =>
  DesktopPowerSaveBlocker.layer.pipe(Layer.provide(fake.layer));

describe("DesktopPowerSaveBlocker", () => {
  it.effect(
    "retains the open-lid display blocker when a delayed close transition finishes after reopening",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const fake = yield* makeFakePowerSaveBlockerWith({
          beforeStart: (type) =>
            type === "prevent-app-suspension"
              ? Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.asVoid,
                )
              : Effect.void,
        });
        yield* Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
          const blocker = yield* DesktopPowerSaveBlocker.DesktopPowerSaveBlocker;
          yield* blocker.update({ mode: "during-chats", chatsRunning: true });
          const owner = yield* blocker.bindClosedLid(() => true);
          owner.observe(true);
          yield* Deferred.await(entered);
          owner.observe(false);
          assert.strictEqual(owner.maySleep(), false);
          yield* Deferred.succeed(release, undefined);
          yield* blocker.snapshot;
          // The original display protection was never stopped after the newer
          // open observation. Only the delayed, now-unwanted CPU ID is released.
          assert.deepStrictEqual([...(yield* Ref.get(fake.activeIds))], [1]);
          assert.deepStrictEqual(yield* Ref.get(fake.stops), [2]);
          assert.deepStrictEqual(yield* Ref.get(fake.starts), [
            "prevent-display-sleep",
            "prevent-app-suspension",
          ]);
          yield* Effect.promise(() => owner.close());
        }).pipe(Effect.scoped, Effect.provide(makeLayer(fake)));
        assert.deepStrictEqual([...(yield* Ref.get(fake.activeIds))], []);
      }),
  );
  it.effect(
    "keeps CPU protection through a rapid close-open-close and waits for the late display blocker to stop",
    () =>
      Effect.gen(function* () {
        let holdDisplayStart = false;
        const startEntered = yield* Deferred.make<void>();
        const releaseStart = yield* Deferred.make<void>();
        const stopEntered = yield* Deferred.make<void>();
        const releaseStop = yield* Deferred.make<void>();
        const fake = yield* makeFakePowerSaveBlockerWith({
          beforeStart: (type) =>
            holdDisplayStart && type === "prevent-display-sleep"
              ? Deferred.succeed(startEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseStart)),
                  Effect.asVoid,
                )
              : Effect.void,
          beforeStop: (id) =>
            id === 3
              ? Deferred.succeed(stopEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseStop)),
                  Effect.asVoid,
                )
              : Effect.void,
        });
        yield* Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.all([
              Deferred.succeed(releaseStart, undefined),
              Deferred.succeed(releaseStop, undefined),
            ]),
          );
          const blocker = yield* DesktopPowerSaveBlocker.DesktopPowerSaveBlocker;
          yield* blocker.update({ mode: "during-chats", chatsRunning: true });
          const owner = yield* blocker.bindClosedLid(() => true);
          owner.observe(true);
          yield* blocker.snapshot;
          assert.strictEqual(owner.maySleep(), true);
          holdDisplayStart = true;
          owner.observe(false);
          yield* Deferred.await(startEntered);
          owner.observe(true);
          assert.strictEqual(owner.maySleep(), false);
          yield* Deferred.succeed(releaseStart, undefined);
          yield* Deferred.await(stopEntered);
          assert.strictEqual(owner.maySleep(), false);
          assert.deepStrictEqual([...(yield* Ref.get(fake.activeIds))], [2, 3]);
          assert.deepStrictEqual(yield* Ref.get(fake.stops), [1]);
          yield* Deferred.succeed(releaseStop, undefined);
          yield* blocker.snapshot;
          assert.strictEqual(owner.maySleep(), true);
          assert.deepStrictEqual([...(yield* Ref.get(fake.activeIds))], [2]);
          assert.deepStrictEqual(yield* Ref.get(fake.stops), [1, 3]);
          yield* Effect.promise(() => owner.close());
        }).pipe(Effect.scoped, Effect.provide(makeLayer(fake)));
        assert.deepStrictEqual([...(yield* Ref.get(fake.activeIds))], []);
      }),
  );
  it.effect(
    "applies a newer open observation even if an already admitted closed-lid stop fails",
    () =>
      Effect.gen(function* () {
        let refuse = true;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const fake = yield* makeFakePowerSaveBlockerWith({
          beforeStop: (id) =>
            id === 1
              ? Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.asVoid,
                )
              : Effect.void,
          refuseStop: (id) => refuse && id === 1,
        });
        yield* Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              refuse = false;
            }),
          );
          yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
          const blocker = yield* DesktopPowerSaveBlocker.DesktopPowerSaveBlocker;
          yield* blocker.update({ mode: "during-chats", chatsRunning: true });
          const owner = yield* blocker.bindClosedLid(() => true);
          owner.observe(true);
          yield* Deferred.await(entered);
          owner.observe(false);
          yield* Deferred.succeed(release, undefined);
          yield* blocker.snapshot;
          assert.strictEqual(owner.maySleep(), false);
          assert.deepStrictEqual([...(yield* Ref.get(fake.activeIds))], [1]);
          assert.deepStrictEqual(yield* Ref.get(fake.stops), [1, 2]);
          yield* Effect.promise(() => owner.close());
        }).pipe(Effect.scoped, Effect.provide(makeLayer(fake)));
      }),
  );
  it.effect(
    "reconciles the latest chat state after held native IO instead of replaying queued starts",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const pending: Promise<void>[] = [];
        const fake = yield* makeFakePowerSaveBlockerWith({
          beforeStart: (type) =>
            type === "prevent-app-suspension"
              ? Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.asVoid,
                )
              : Effect.void,
        });
        yield* Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Effect.promise(() => Promise.allSettled(pending)));
          yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
          const run = Effect.runPromiseWith(yield* Effect.context<never>());
          const blocker = yield* DesktopPowerSaveBlocker.DesktopPowerSaveBlocker;
          yield* blocker.update({ mode: "during-chats", chatsRunning: true });
          const owner = yield* blocker.bindClosedLid(() => true);
          owner.observe(true);
          yield* Deferred.await(entered);
          pending.push(run(blocker.update({ mode: "during-chats", chatsRunning: false })));
          pending.push(run(blocker.update({ mode: "during-chats", chatsRunning: true })));
          pending.push(run(blocker.update({ mode: "during-chats", chatsRunning: false })));
          yield* Deferred.succeed(release, undefined);
          yield* Effect.promise(() => Promise.all(pending));
          assert.deepStrictEqual((yield* blocker.snapshot).desiredState, {
            mode: "during-chats",
            chatsRunning: false,
          });
          assert.deepStrictEqual([...(yield* Ref.get(fake.activeIds))], []);
          assert.deepStrictEqual(yield* Ref.get(fake.starts), [
            "prevent-display-sleep",
            "prevent-app-suspension",
          ]);
          owner.observe(false);
          yield* blocker.snapshot;
          assert.deepStrictEqual([...(yield* Ref.get(fake.activeIds))], []);
          yield* Effect.promise(() => owner.close());
        }).pipe(Effect.scoped, Effect.provide(makeLayer(fake)));
      }),
  );
  it.effect(
    "finishes admitted chat-stop policy when its IPC waiter is cancelled during native IO",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let pending: Promise<string> | undefined;
        const fake = yield* makeFakePowerSaveBlockerWith({
          beforeStart: (type) =>
            type === "prevent-app-suspension"
              ? Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.asVoid,
                )
              : Effect.void,
        });
        yield* Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              await pending;
            }),
          );
          yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
          const run = Effect.runPromiseWith(yield* Effect.context<never>());
          const blocker = yield* DesktopPowerSaveBlocker.DesktopPowerSaveBlocker;
          yield* blocker.update({ mode: "during-chats", chatsRunning: true });
          const owner = yield* blocker.bindClosedLid(() => true);
          owner.observe(true);
          yield* Deferred.await(entered);
          const cancellation = new AbortController();
          // run starts this exact intent synchronously up to the held mutex.
          pending = run(blocker.update({ mode: "during-chats", chatsRunning: false }), {
            signal: cancellation.signal,
          }).then(
            () => "completed",
            () => "cancelled",
          );
          cancellation.abort();
          yield* Deferred.succeed(release, undefined);
          assert.strictEqual(yield* Effect.promise(() => pending!), "cancelled");
          assert.deepStrictEqual((yield* blocker.snapshot).desiredState, {
            mode: "during-chats",
            chatsRunning: false,
          });
          assert.deepStrictEqual([...(yield* Ref.get(fake.activeIds))], []);
          yield* Effect.promise(() => owner.close());
        }).pipe(Effect.scoped, Effect.provide(makeLayer(fake)));
        assert.deepStrictEqual([...(yield* Ref.get(fake.activeIds))], []);
      }),
  );
  for (const mode of ["always", "during-chats"] as const) {
    it.effect(
      `permits closed-lid display sleep while retaining CPU protection in ${mode} mode`,
      () =>
        Effect.gen(function* () {
          const fake = yield* makeFakePowerSaveBlocker;
          yield* Effect.gen(function* () {
            const blocker = yield* DesktopPowerSaveBlocker.DesktopPowerSaveBlocker;
            const wanted = { mode, chatsRunning: true };
            yield* blocker.update(wanted);
            const owner = yield* blocker.bindClosedLid(() => true);
            owner.observe(true);
            assert.deepStrictEqual((yield* blocker.snapshot).desiredState, wanted);
            assert.strictEqual(owner.maySleep(), true);
            assert.deepStrictEqual(yield* Ref.get(fake.starts), [
              "prevent-display-sleep",
              "prevent-app-suspension",
            ]);
            assert.deepStrictEqual([...(yield* Ref.get(fake.activeIds))], [2]);
            owner.observe(false);
            assert.strictEqual(owner.maySleep(), false);
            yield* blocker.snapshot;
            assert.deepStrictEqual(yield* Ref.get(fake.starts), [
              "prevent-display-sleep",
              "prevent-app-suspension",
              "prevent-display-sleep",
            ]);
            assert.deepStrictEqual([...(yield* Ref.get(fake.activeIds))], [3]);
            yield* Effect.promise(() => owner.close());
          }).pipe(Effect.provide(makeLayer(fake)));
          assert.deepStrictEqual([...(yield* Ref.get(fake.activeIds))], []);
        }),
    );
  }
  it.effect("retains an Off preference and rejects retired or noncurrent lid owners", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePowerSaveBlocker;
      yield* Effect.gen(function* () {
        const blocker = yield* DesktopPowerSaveBlocker.DesktopPowerSaveBlocker;
        let current = true;
        const first = yield* blocker.bindClosedLid(() => current);
        first.observe(true);
        yield* blocker.snapshot;
        assert.strictEqual(first.maySleep(), true);
        assert.deepStrictEqual(yield* Ref.get(fake.starts), []);
        current = false;
        assert.strictEqual(first.maySleep(), false);
        yield* Effect.promise(() => first.close());
        const next = yield* blocker.bindClosedLid(() => true);
        first.observe(true);
        assert.strictEqual(first.maySleep(), false);
        assert.strictEqual(next.maySleep(), false);
        next.observe(true);
        yield* blocker.snapshot;
        assert.strictEqual(next.maySleep(), true);
        yield* Effect.promise(() => first.close());
        assert.strictEqual(next.maySleep(), true);
        yield* Effect.promise(() => next.close());
      }).pipe(Effect.provide(makeLayer(fake)));
    }),
  );
  it.effect(
    "waits for actual native release and joins a pending transition before replacement",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const fake = yield* makeFakePowerSaveBlockerWith({
          beforeStop: (id) =>
            id === 1
              ? Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.asVoid,
                )
              : Effect.void,
        });
        yield* Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
          const blocker = yield* DesktopPowerSaveBlocker.DesktopPowerSaveBlocker;
          yield* blocker.update({ mode: "always", chatsRunning: true });
          const owner = yield* blocker.bindClosedLid(() => true);
          owner.observe(true);
          yield* Deferred.await(entered);
          assert.strictEqual(owner.maySleep(), false);
          assert.deepStrictEqual([...(yield* Ref.get(fake.activeIds))], [1, 2]);
          let closed = false;
          const closing = owner.close().then(() => {
            closed = true;
          });
          assert.strictEqual(closed, false);
          assert.strictEqual(owner.maySleep(), false);
          assert.strictEqual(
            Exit.isFailure(yield* Effect.exit(blocker.bindClosedLid(() => true))),
            true,
          );
          owner.observe(true);
          yield* Deferred.succeed(release, undefined);
          yield* Effect.promise(() => closing);
          assert.strictEqual(closed, true);
          assert.deepStrictEqual([...(yield* Ref.get(fake.activeIds))], [3]);
          const next = yield* blocker.bindClosedLid(() => true);
          yield* Effect.promise(() => next.close());
        }).pipe(Effect.scoped, Effect.provide(makeLayer(fake)));
        assert.deepStrictEqual([...(yield* Ref.get(fake.activeIds))], []);
      }),
  );
  it.effect("bounds retained native blockers and refuses adoption when a stop is not applied", () =>
    Effect.gen(function* () {
      let refuse = true;
      const fake = yield* makeFakePowerSaveBlockerWith({ refuseStop: (id) => refuse && id === 1 });
      yield* Effect.gen(function* () {
        const blocker = yield* DesktopPowerSaveBlocker.DesktopPowerSaveBlocker;
        yield* blocker.update({ mode: "always", chatsRunning: false });
        const owner = yield* blocker.bindClosedLid(() => true);
        for (let index = 0; index < 10; index++) {
          owner.observe(true);
          yield* blocker.snapshot;
          assert.strictEqual(owner.maySleep(), false);
          assert.strictEqual((yield* Ref.get(fake.starts)).length, 2);
          assert.strictEqual((yield* Ref.get(fake.activeIds)).size, 2);
        }
        refuse = false;
        owner.observe(true);
        yield* blocker.snapshot;
        assert.strictEqual(owner.maySleep(), true);
        yield* Effect.promise(() => owner.close());
      }).pipe(Effect.provide(makeLayer(fake)));
      assert.deepStrictEqual([...(yield* Ref.get(fake.activeIds))], []);
    }),
  );
  it.effect("keeps the blocker off by default and starts it for always mode", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePowerSaveBlocker;

      yield* Effect.gen(function* () {
        const blocker = yield* DesktopPowerSaveBlocker.DesktopPowerSaveBlocker;

        assert.deepStrictEqual(yield* Ref.get(fake.starts), []);

        yield* blocker.update({ mode: "always", chatsRunning: false });
        assert.deepStrictEqual(yield* Ref.get(fake.starts), ["prevent-display-sleep"]);
        assert.strictEqual((yield* blocker.snapshot).active, true);

        yield* blocker.update({ mode: "always", chatsRunning: true });
        assert.deepStrictEqual(yield* Ref.get(fake.starts), ["prevent-display-sleep"]);
      }).pipe(Effect.provide(makeLayer(fake)));
    }),
  );

  it.effect("tracks running chats when configured for during-chats mode", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePowerSaveBlocker;

      yield* Effect.gen(function* () {
        const blocker = yield* DesktopPowerSaveBlocker.DesktopPowerSaveBlocker;

        yield* blocker.update({ mode: "during-chats", chatsRunning: false });
        assert.deepStrictEqual(yield* Ref.get(fake.starts), []);

        yield* blocker.update({ mode: "during-chats", chatsRunning: true });
        assert.deepStrictEqual(yield* Ref.get(fake.starts), ["prevent-display-sleep"]);
        assert.strictEqual((yield* blocker.snapshot).active, true);

        yield* blocker.update({ mode: "during-chats", chatsRunning: false });
        assert.deepStrictEqual(yield* Ref.get(fake.stops), [1]);
        assert.strictEqual((yield* blocker.snapshot).active, false);
      }).pipe(Effect.provide(makeLayer(fake)));
    }),
  );

  it.effect("stops the active blocker when disabled", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePowerSaveBlocker;

      yield* Effect.gen(function* () {
        const blocker = yield* DesktopPowerSaveBlocker.DesktopPowerSaveBlocker;
        yield* blocker.update({ mode: "always", chatsRunning: false });
        yield* blocker.update({ mode: "off", chatsRunning: true });

        assert.deepStrictEqual(yield* Ref.get(fake.stops), [1]);
        assert.deepStrictEqual([...(yield* Ref.get(fake.activeIds))], []);
      }).pipe(Effect.provide(makeLayer(fake)));
    }),
  );
});
