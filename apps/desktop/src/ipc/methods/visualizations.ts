import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Electron from "electron";
import {
  VisualizationHostCapabilities,
  VisualizationHostOpenInput,
  VisualizationHostState,
  VisualizationHostUpdateInput,
  VisualizationHostLeaseInput,
  VisualizationHostCapture,
  VisualizationHostMessageInput,
  VisualizationHostSuspendInput,
  VisualizationHostCapacity,
  VisualizationHostYieldResult,
  VisualizationHostCapacityObservation,
} from "@cafecode/contracts/visualizationHost";

import { DesktopVisualizations } from "../../visualizations/DesktopVisualizations.ts";
import { makeIpcMethod, type DesktopIpcInvokeEvent, type DesktopIpcMethod } from "../DesktopIpc.ts";
import * as Channels from "../channels.ts";

function owner(event: DesktopIpcInvokeEvent): Electron.BrowserWindow {
  const contents = event.sender as Electron.WebContents | undefined;
  const frame = event.senderFrame;
  const window = contents ? Electron.BrowserWindow.fromWebContents(contents) : null;
  if (
    !window ||
    window.isDestroyed() ||
    !contents ||
    contents.isDestroyed() ||
    !frame ||
    frame.detached !== false ||
    frame.frameToken !== contents.mainFrame.frameToken ||
    frame.url !== contents.mainFrame.url
  )
    throw new Error("Visualization owner is unavailable.");
  return window;
}
// Schema issues may retain the rejected bearer ticket. Replace the complete
// failure before it leaves this method, without formatting or logging its cause.
function privateMethod<E, R>(method: DesktopIpcMethod<E, R>): DesktopIpcMethod<Error, R> {
  return {
    ...method,
    handler: (raw, event) =>
      method
        .handler(raw, event)
        .pipe(
          Effect.catchCause(() => Effect.fail(new Error("Visualization request was refused."))),
        ),
  };
}
export const getVisualizationHostCapabilities = privateMethod(
  makeIpcMethod({
    channel: Channels.VISUALIZATION_CAPABILITIES_CHANNEL,
    payload: Schema.Void,
    result: VisualizationHostCapabilities,
    handler: () =>
      Effect.gen(function* () {
        const host = yield* DesktopVisualizations;
        return host.capabilities();
      }),
  }),
);
export const getVisualizationHostCapacity = privateMethod(
  makeIpcMethod({
    channel: Channels.VISUALIZATION_CAPACITY_CHANNEL,
    payload: Schema.Void,
    result: VisualizationHostCapacity,
    handler: (_input, event) =>
      Effect.gen(function* () {
        owner(event);
        const host = yield* DesktopVisualizations;
        return host.capacity();
      }),
  }),
);
export const observeVisualizationCapacity = privateMethod(
  makeIpcMethod({
    channel: Channels.VISUALIZATION_CAPACITY_OBSERVE_CHANNEL,
    payload: VisualizationHostCapacityObservation,
    result: Schema.NullOr(VisualizationHostCapacity),
    handler: (input, event) =>
      Effect.gen(function* () {
        const host = yield* DesktopVisualizations;
        return host.observeCapacity(owner(event), input.observing, input.observerId, input.sequence)
          ? host.capacity()
          : null;
      }),
  }),
);
export const yieldVisualization = privateMethod(
  makeIpcMethod({
    channel: Channels.VISUALIZATION_YIELD_CHANNEL,
    payload: VisualizationHostLeaseInput,
    result: VisualizationHostYieldResult,
    handler: (input, event) =>
      Effect.gen(function* () {
        const host = yield* DesktopVisualizations;
        return yield* Effect.promise(() => host.yield(owner(event), input.leaseId));
      }),
  }),
);
export const beginVisualizationTransition = privateMethod(
  makeIpcMethod({
    channel: Channels.VISUALIZATION_TRANSITION_CHANNEL,
    payload: VisualizationHostLeaseInput,
    result: Schema.Boolean,
    handler: (input, event) =>
      Effect.gen(function* () {
        const host = yield* DesktopVisualizations;
        return host.beginTransition(owner(event), input.leaseId);
      }),
  }),
);
export const openVisualization = privateMethod(
  makeIpcMethod({
    channel: Channels.VISUALIZATION_OPEN_CHANNEL,
    payload: VisualizationHostOpenInput,
    result: VisualizationHostState,
    handler: (input, event) =>
      Effect.gen(function* () {
        const host = yield* DesktopVisualizations;
        return yield* Effect.promise(() => host.open(owner(event), input));
      }),
  }),
);
export const focusVisualization = privateMethod(
  makeIpcMethod({
    channel: Channels.VISUALIZATION_FOCUS_CHANNEL,
    payload: VisualizationHostLeaseInput,
    result: Schema.Boolean,
    handler: (input, event) =>
      Effect.gen(function* () {
        const host = yield* DesktopVisualizations;
        return host.focus(owner(event), input.leaseId);
      }),
  }),
);
export const updateVisualization = privateMethod(
  makeIpcMethod({
    channel: Channels.VISUALIZATION_UPDATE_CHANNEL,
    payload: VisualizationHostUpdateInput,
    result: VisualizationHostState,
    handler: (input, event) =>
      Effect.gen(function* () {
        const host = yield* DesktopVisualizations;
        return yield* Effect.promise(() => host.update(owner(event), input));
      }),
  }),
);
export const retireVisualization = privateMethod(
  makeIpcMethod({
    channel: Channels.VISUALIZATION_RETIRE_CHANNEL,
    payload: VisualizationHostLeaseInput,
    result: VisualizationHostState,
    handler: (input, event) =>
      Effect.gen(function* () {
        const host = yield* DesktopVisualizations;
        return yield* Effect.promise(() => host.retire(owner(event), input.leaseId));
      }),
  }),
);
export const captureVisualization = privateMethod(
  makeIpcMethod({
    channel: Channels.VISUALIZATION_CAPTURE_CHANNEL,
    payload: VisualizationHostLeaseInput,
    result: Schema.NullOr(VisualizationHostCapture),
    handler: (input, event) =>
      Effect.gen(function* () {
        const host = yield* DesktopVisualizations;
        return yield* Effect.promise(() => host.capture(owner(event), input.leaseId));
      }),
  }),
);
export const sendVisualizationMessage = privateMethod(
  makeIpcMethod({
    channel: Channels.VISUALIZATION_MESSAGE_CHANNEL,
    payload: VisualizationHostMessageInput,
    result: Schema.Boolean,
    handler: (input, event) =>
      Effect.gen(function* () {
        const host = yield* DesktopVisualizations;
        return host.send(owner(event), input.leaseId, input.json);
      }),
  }),
);
export const suspendVisualization = privateMethod(
  makeIpcMethod({
    channel: Channels.VISUALIZATION_SUSPEND_CHANNEL,
    payload: VisualizationHostSuspendInput,
    result: Schema.Boolean,
    handler: (input, event) =>
      Effect.gen(function* () {
        const host = yield* DesktopVisualizations;
        return host.suspend(owner(event), input.leaseId, input.suspended, input.consentId);
      }),
  }),
);
