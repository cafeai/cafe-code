import type { DesktopPowerSaveBlockerState } from "@cafecode/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import * as ElectronPowerSaveBlocker from "../electron/ElectronPowerSaveBlocker.ts";

const INITIAL_STATE: DesktopPowerSaveBlockerState = {
  mode: "off",
  chatsRunning: false,
};

export interface DesktopPowerSaveBlockerSnapshot {
  readonly desiredState: DesktopPowerSaveBlockerState;
  readonly blockerId: number | null;
  readonly active: boolean;
}

export interface DesktopPowerSaveBlockerShape {
  readonly update: (state: DesktopPowerSaveBlockerState) => Effect.Effect<void>;
  readonly snapshot: Effect.Effect<DesktopPowerSaveBlockerSnapshot>;
}

export class DesktopPowerSaveBlocker extends Context.Service<
  DesktopPowerSaveBlocker,
  DesktopPowerSaveBlockerShape
>()("cafecode/desktop/app/PowerSaveBlocker") {}

function shouldBlockSleep(state: DesktopPowerSaveBlockerState): boolean {
  return state.mode === "always" || (state.mode === "during-chats" && state.chatsRunning);
}

const make = Effect.fn("desktop.powerSaveBlocker.make")(function* () {
  const powerSaveBlocker = yield* ElectronPowerSaveBlocker.ElectronPowerSaveBlocker;
  const desiredStateRef = yield* Ref.make(INITIAL_STATE);
  const blockerIdRef = yield* Ref.make<number | null>(null);
  const mutex = yield* Semaphore.make(1);

  const stopActiveBlocker = Effect.fn("desktop.powerSaveBlocker.stopActive")(function* () {
    const blockerId = yield* Ref.getAndSet(blockerIdRef, null);
    if (blockerId === null) {
      return;
    }

    const started = yield* powerSaveBlocker.isStarted(blockerId);
    if (started) {
      yield* powerSaveBlocker.stop(blockerId);
    }
  });

  const startBlockerIfNeeded = Effect.fn("desktop.powerSaveBlocker.startIfNeeded")(function* () {
    const currentBlockerId = yield* Ref.get(blockerIdRef);
    if (currentBlockerId !== null) {
      const currentStarted = yield* powerSaveBlocker.isStarted(currentBlockerId);
      if (currentStarted) {
        return;
      }
      yield* Ref.set(blockerIdRef, null);
    }

    const nextBlockerId = yield* powerSaveBlocker.start("prevent-display-sleep");
    yield* Ref.set(blockerIdRef, nextBlockerId);
  });

  const applyDesiredState = Effect.fn("desktop.powerSaveBlocker.apply")(function* (
    state: DesktopPowerSaveBlockerState,
  ) {
    yield* Ref.set(desiredStateRef, state);

    if (shouldBlockSleep(state)) {
      yield* startBlockerIfNeeded();
      return;
    }

    yield* stopActiveBlocker();
  });

  const update = (state: DesktopPowerSaveBlockerState) =>
    mutex.withPermit(applyDesiredState(state)).pipe(
      Effect.asVoid,
      Effect.withSpan("desktop.powerSaveBlocker.update", {
        attributes: {
          mode: state.mode,
          chatsRunning: state.chatsRunning,
        },
      }),
    );

  const snapshot = mutex.withPermit(
    Effect.gen(function* () {
      const [desiredState, blockerId] = yield* Effect.all([
        Ref.get(desiredStateRef),
        Ref.get(blockerIdRef),
      ]);
      const active = blockerId === null ? false : yield* powerSaveBlocker.isStarted(blockerId);
      return {
        desiredState,
        blockerId,
        active,
      };
    }),
  );

  yield* Effect.addFinalizer(() => mutex.withPermit(stopActiveBlocker()).pipe(Effect.ignore));

  return DesktopPowerSaveBlocker.of({
    update,
    snapshot,
  });
});

export const layer = Layer.effect(DesktopPowerSaveBlocker, make());
