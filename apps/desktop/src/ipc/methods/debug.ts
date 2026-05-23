import {
  DesktopDebugEndpointStateSchema,
  DesktopRendererDebugSnapshotSchema,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopDebugServer from "../../debug/DesktopDebugServer.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const getDebugEndpointState = makeIpcMethod({
  channel: IpcChannels.GET_DEBUG_ENDPOINT_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopDebugEndpointStateSchema,
  handler: () => DesktopDebugServer.getDebugEndpointState,
});

export const publishDebugSnapshot = makeIpcMethod({
  channel: IpcChannels.PUBLISH_DEBUG_SNAPSHOT_CHANNEL,
  payload: DesktopRendererDebugSnapshotSchema,
  result: Schema.Void,
  handler: (snapshot) =>
    DesktopDebugServer.publishRendererDebugSnapshot(snapshot).pipe(Effect.asVoid),
});
