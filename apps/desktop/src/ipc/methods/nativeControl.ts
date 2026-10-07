import { NativeControlResultSchema, NativeControlStateSchema } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { DesktopNativeControl } from "../../nativeControl/DesktopNativeControl.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const getNativeControlState = makeIpcMethod({
  channel: IpcChannels.NATIVE_CONTROL_STATE_CHANNEL,
  payload: Schema.Void,
  result: NativeControlStateSchema,
  handler: Effect.fn("desktop.nativeControl.state")(function* () {
    const host = yield* DesktopNativeControl;
    return yield* Effect.promise(() => host.state());
  }),
});
export const setNativeControlEnabled = makeIpcMethod({
  channel: IpcChannels.NATIVE_CONTROL_ENABLE_CHANNEL,
  payload: Schema.Boolean,
  result: NativeControlStateSchema,
  handler: Effect.fn("desktop.nativeControl.enable")(function* (enabled) {
    const host = yield* DesktopNativeControl;
    return yield* Effect.promise(() => host.setEnabled(enabled));
  }),
});
export const getNativeControlDiagnostics = makeIpcMethod({
  channel: IpcChannels.NATIVE_CONTROL_DIAGNOSTICS_CHANNEL,
  payload: Schema.Void,
  result: NativeControlResultSchema,
  handler: Effect.fn("desktop.nativeControl.diagnostics")(function* () {
    const host = yield* DesktopNativeControl;
    return yield* Effect.promise(() => host.diagnostics());
  }),
});
export const captureNativeControlPreview = makeIpcMethod({
  channel: IpcChannels.NATIVE_CONTROL_PREVIEW_CHANNEL,
  payload: Schema.Void,
  result: NativeControlResultSchema,
  handler: Effect.fn("desktop.nativeControl.preview")(function* () {
    const host = yield* DesktopNativeControl;
    return yield* Effect.promise(() => host.preview());
  }),
});
