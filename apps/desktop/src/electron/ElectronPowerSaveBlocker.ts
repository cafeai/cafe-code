import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";

export type ElectronPowerSaveBlockerType = "prevent-app-suspension" | "prevent-display-sleep";

export interface ElectronPowerSaveBlockerShape {
  readonly start: (type: ElectronPowerSaveBlockerType) => Effect.Effect<number>;
  readonly stop: (id: number) => Effect.Effect<void>;
  readonly isStarted: (id: number) => Effect.Effect<boolean>;
}

export class ElectronPowerSaveBlocker extends Context.Service<
  ElectronPowerSaveBlocker,
  ElectronPowerSaveBlockerShape
>()("cafecode/desktop/electron/PowerSaveBlocker") {}

const make = ElectronPowerSaveBlocker.of({
  start: (type) => Effect.sync(() => Electron.powerSaveBlocker.start(type)),
  stop: (id) =>
    Effect.sync(() => {
      Electron.powerSaveBlocker.stop(id);
    }),
  isStarted: (id) => Effect.sync(() => Electron.powerSaveBlocker.isStarted(id)),
});

export const layer = Layer.succeed(ElectronPowerSaveBlocker, make);
