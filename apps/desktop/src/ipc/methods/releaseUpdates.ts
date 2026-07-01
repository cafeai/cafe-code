import { DesktopReleaseUpdateStateSchema } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopReleaseUpdates from "../../updates/DesktopReleaseUpdates.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const getReleaseUpdateState = makeIpcMethod({
  channel: IpcChannels.RELEASE_UPDATE_GET_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopReleaseUpdateStateSchema,
  handler: Effect.fn("desktop.ipc.releaseUpdates.getState")(function* () {
    const updates = yield* DesktopReleaseUpdates.DesktopReleaseUpdates;
    return yield* updates.getState;
  }),
});

export const checkReleaseUpdate = makeIpcMethod({
  channel: IpcChannels.RELEASE_UPDATE_CHECK_CHANNEL,
  payload: Schema.Void,
  result: DesktopReleaseUpdateStateSchema,
  handler: Effect.fn("desktop.ipc.releaseUpdates.check")(function* () {
    const updates = yield* DesktopReleaseUpdates.DesktopReleaseUpdates;
    return yield* updates.check("web-ui");
  }),
});
