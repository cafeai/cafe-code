import {
  RemoteCertificateInspectionSchema,
  RemoteCertificatePreparationSchema,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopRemoteCertificates from "../../settings/DesktopRemoteCertificates.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const inspectRemoteCertificate = makeIpcMethod({
  channel: IpcChannels.INSPECT_REMOTE_CERTIFICATE_CHANNEL,
  payload: Schema.String.check(
    Schema.makeFilter((value) =>
      value.length <= 2_048 ? undefined : "Server address is too long",
    ),
  ),
  result: RemoteCertificateInspectionSchema,
  handler: Effect.fn("desktop.ipc.remoteCertificates.inspect")(function* (httpBaseUrl) {
    const certificates = yield* DesktopRemoteCertificates.DesktopRemoteCertificates;
    return yield* certificates.inspect(httpBaseUrl);
  }),
});

export const prepareRemoteCertificate = makeIpcMethod({
  channel: IpcChannels.PREPARE_REMOTE_CERTIFICATE_CHANNEL,
  payload: Schema.String.check(
    Schema.makeFilter((value) =>
      value.length <= 2_048 ? undefined : "Server address is too long",
    ),
  ),
  result: RemoteCertificatePreparationSchema,
  handler: Effect.fn("desktop.ipc.remoteCertificates.prepare")(function* (httpBaseUrl) {
    const certificates = yield* DesktopRemoteCertificates.DesktopRemoteCertificates;
    return yield* certificates.prepare(httpBaseUrl);
  }),
});
