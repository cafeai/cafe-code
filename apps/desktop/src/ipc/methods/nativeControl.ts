import {
  NativeControlChatStateSchema,
  NativeControlPermissionsStateSchema,
  NativeControlResultSchema,
  NativeControlStateSchema,
  ThreadId,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { DesktopNativeControl } from "../../nativeControl/DesktopNativeControl.ts";
import { DesktopNativePermissions } from "../../nativeControl/DesktopNativePermissions.ts";
import { ElectronWindow } from "../../electron/ElectronWindow.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

// Invalidation carries no chat IDs or capabilities. Each trusted renderer
// reads its own captured chat again; late replies cannot switch chat policy.
const notifyNativeControlChanged = Effect.gen(function* () {
  const windows = yield* ElectronWindow;
  yield* windows.sendAll(IpcChannels.NATIVE_CONTROL_CHANGED_CHANNEL);
});

const promptForNativePermissions = Effect.gen(function* () {
  const permissions = yield* DesktopNativePermissions;
  yield* permissions.prompt().pipe(
    Effect.catchCause(() => Effect.logWarning("Could not show computer-use permissions.")),
    Effect.forkScoped,
  );
});

export const getNativeControlPermissions = makeIpcMethod({
  channel: IpcChannels.NATIVE_CONTROL_PERMISSIONS_CHANNEL,
  payload: Schema.Void,
  result: NativeControlPermissionsStateSchema,
  handler: Effect.fn("desktop.nativeControl.permissions")(function* () {
    const permissions = yield* DesktopNativePermissions;
    return yield* permissions.state;
  }),
});

export const requestNativeControlPermissions = makeIpcMethod({
  channel: IpcChannels.NATIVE_CONTROL_REQUEST_PERMISSIONS_CHANNEL,
  payload: Schema.Void,
  result: NativeControlPermissionsStateSchema,
  handler: Effect.fn("desktop.nativeControl.requestPermissions")(function* () {
    const permissions = yield* DesktopNativePermissions;
    return yield* permissions.prompt();
  }),
});

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
    const state = yield* Effect.promise(() => host.setEnabled(enabled));
    yield* notifyNativeControlChanged;
    if (enabled) yield* promptForNativePermissions;
    return state;
  }),
});

export const getNativeControlChatState = makeIpcMethod({
  channel: IpcChannels.NATIVE_CONTROL_CHAT_STATE_CHANNEL,
  payload: ThreadId,
  result: NativeControlChatStateSchema,
  handler: Effect.fn("desktop.nativeControl.chatState")(function* (threadId) {
    const host = yield* DesktopNativeControl;
    return yield* Effect.promise(() => host.chatState(threadId));
  }),
});

export const setNativeControlChatEnabled = makeIpcMethod({
  channel: IpcChannels.NATIVE_CONTROL_CHAT_ENABLE_CHANNEL,
  payload: Schema.Struct({ threadId: ThreadId, enabled: Schema.Boolean }),
  result: NativeControlChatStateSchema,
  handler: Effect.fn("desktop.nativeControl.chatEnable")(function* ({ threadId, enabled }) {
    const host = yield* DesktopNativeControl;
    const state = yield* Effect.promise(() => host.setChatEnabled(threadId, enabled));
    yield* notifyNativeControlChanged;
    if (enabled) yield* promptForNativePermissions;
    return state;
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
