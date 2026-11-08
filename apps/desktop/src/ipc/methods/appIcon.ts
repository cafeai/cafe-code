import { DesktopAppIconStateSchema, SetDesktopAppIconInputSchema } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopAppIcon from "../../app/DesktopAppIcon.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const getAppIconState = makeIpcMethod({
  channel: IpcChannels.GET_APP_ICON_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopAppIconStateSchema,
  handler: Effect.fn("desktop.ipc.appIcon.getState")(function* () {
    const appIcon = yield* DesktopAppIcon.DesktopAppIcon;
    return yield* appIcon.getState;
  }),
});

const setAppIconMethod = makeIpcMethod({
  channel: IpcChannels.SET_APP_ICON_CHANNEL,
  payload: SetDesktopAppIconInputSchema,
  result: DesktopAppIconStateSchema,
  handler: Effect.fn("desktop.ipc.appIcon.set")(function* (input) {
    const appIcon = yield* DesktopAppIcon.DesktopAppIcon;
    return yield* appIcon.setIcon(input);
  }),
});

export const setAppIcon = {
  ...setAppIconMethod,
  // Schema failures can retain the rejected image bytes. Return only a fixed
  // failure across IPC; never echo pixels or decoder details to the renderer.
  handler: (...args: Parameters<typeof setAppIconMethod.handler>) =>
    setAppIconMethod
      .handler(...args)
      .pipe(Effect.catch(() => Effect.fail(new DesktopAppIcon.DesktopAppIconError()))),
};
