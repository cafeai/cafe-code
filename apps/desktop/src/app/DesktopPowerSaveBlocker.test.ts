import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ElectronPowerSaveBlocker from "../electron/ElectronPowerSaveBlocker.ts";
import * as DesktopPowerSaveBlocker from "./DesktopPowerSaveBlocker.ts";

interface FakePowerSaveBlocker {
  readonly starts: Ref.Ref<readonly ElectronPowerSaveBlocker.ElectronPowerSaveBlockerType[]>;
  readonly stops: Ref.Ref<readonly number[]>;
  readonly activeIds: Ref.Ref<ReadonlySet<number>>;
  readonly layer: Layer.Layer<ElectronPowerSaveBlocker.ElectronPowerSaveBlocker>;
}

const makeFakePowerSaveBlocker = Effect.gen(function* () {
  const starts = yield* Ref.make<readonly ElectronPowerSaveBlocker.ElectronPowerSaveBlockerType[]>(
    [],
  );
  const stops = yield* Ref.make<readonly number[]>([]);
  const activeIds = yield* Ref.make<ReadonlySet<number>>(new Set());
  const nextId = yield* Ref.make(1);

  const layer = Layer.succeed(ElectronPowerSaveBlocker.ElectronPowerSaveBlocker, {
    start: (type) =>
      Effect.gen(function* () {
        const id = yield* Ref.getAndUpdate(nextId, (value) => value + 1);
        yield* Ref.update(starts, (values) => [...values, type]);
        yield* Ref.update(activeIds, (values) => new Set(values).add(id));
        return id;
      }),
    stop: (id) =>
      Effect.gen(function* () {
        yield* Ref.update(stops, (values) => [...values, id]);
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

const makeLayer = (fake: FakePowerSaveBlocker) =>
  DesktopPowerSaveBlocker.layer.pipe(Layer.provide(fake.layer));

describe("DesktopPowerSaveBlocker", () => {
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
