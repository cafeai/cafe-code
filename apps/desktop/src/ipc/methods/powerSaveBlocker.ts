import { DesktopPowerSaveBlockerStateSchema } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopPowerSaveBlocker from "../../app/DesktopPowerSaveBlocker.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const setPowerSaveBlockerState = makeIpcMethod({
  channel: IpcChannels.SET_POWER_SAVE_BLOCKER_STATE_CHANNEL,
  payload: DesktopPowerSaveBlockerStateSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.powerSaveBlocker.setState")(function* (state) {
    const powerSaveBlocker = yield* DesktopPowerSaveBlocker.DesktopPowerSaveBlocker;
    yield* powerSaveBlocker.update(state);
  }),
});
