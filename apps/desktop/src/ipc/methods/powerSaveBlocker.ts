import { DesktopPowerSaveBlockerStateSchema, MacKeepAwakeStateSchema } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopPowerSaveBlocker from "../../app/DesktopPowerSaveBlocker.ts";
import { DesktopMacKeepAwake } from "../../app/DesktopMacKeepAwake.ts";
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

export const getMacKeepAwakeState = makeIpcMethod({
  channel: IpcChannels.GET_MAC_KEEP_AWAKE_STATE_CHANNEL,
  payload: Schema.Void,
  result: MacKeepAwakeStateSchema,
  handler: Effect.fn("desktop.ipc.macKeepAwake.snapshot")(function* () {
    const service = yield* DesktopMacKeepAwake;
    return yield* service.snapshot;
  }),
});

export const setMacKeepAwakeIntent = makeIpcMethod({
  channel: IpcChannels.SET_MAC_KEEP_AWAKE_INTENT_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.macKeepAwake.intent")(function* (enabled) {
    const service = yield* DesktopMacKeepAwake;
    yield* service.setIntent(enabled);
  }),
});
