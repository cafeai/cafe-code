import { DesktopSourceUpdateStateSchema } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopSourceUpdates from "../../updates/DesktopSourceUpdates.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const getSourceUpdateState = makeIpcMethod({
  channel: IpcChannels.SOURCE_UPDATE_GET_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopSourceUpdateStateSchema,
  handler: Effect.fn("desktop.ipc.sourceUpdates.getState")(function* () {
    const updates = yield* DesktopSourceUpdates.DesktopSourceUpdates;
    return yield* updates.getState;
  }),
});

export const checkSourceUpdate = makeIpcMethod({
  channel: IpcChannels.SOURCE_UPDATE_CHECK_CHANNEL,
  payload: Schema.Void,
  result: DesktopSourceUpdateStateSchema,
  handler: Effect.fn("desktop.ipc.sourceUpdates.check")(function* () {
    const updates = yield* DesktopSourceUpdates.DesktopSourceUpdates;
    return yield* updates.check("web-ui");
  }),
});
