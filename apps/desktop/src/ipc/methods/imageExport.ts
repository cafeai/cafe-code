import { PngBytesSchema, SavePngInputSchema, SavePngResultSchema } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Electron from "electron";

import { decodePng, PngExportError, savePngFile } from "../../imageExport/PngExport.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

// A compromised renderer must not open an unbounded stack of native modals or
// retain one admitted bitmap per pending picker. Duplicate requests are refused,
// never queued or retried; a later fresh gesture can proceed after this settles.
const pendingSaveOwners = new WeakSet<object>();

const copyPngMethod = makeIpcMethod({
  channel: IpcChannels.COPY_PNG_CHANNEL,
  payload: PngBytesSchema,
  result: Schema.Void,
  handler: (png) =>
    Effect.try({
      try: () => {
        const { image } = decodePng(png, (bytes) => Electron.nativeImage.createFromBuffer(bytes));
        // The sole native clipboard operation is a write after independent PNG
        // admission and decoding. Never inspect/read the user's old clipboard.
        Electron.clipboard.writeImage(image);
      },
      catch: () => new PngExportError(),
    }),
});

export const copyPng = {
  ...copyPngMethod,
  // Schema failures may retain the rejected payload internally. Return only a
  // fixed failure across IPC; never expose pixels or arbitrary decoder details.
  handler: (...args: Parameters<typeof copyPngMethod.handler>) =>
    copyPngMethod.handler(...args).pipe(Effect.catch(() => Effect.fail(new PngExportError()))),
};

const savePngMethod = makeIpcMethod({
  channel: IpcChannels.SAVE_PNG_CHANNEL,
  payload: SavePngInputSchema,
  result: SavePngResultSchema,
  handler: (input, event) =>
    Effect.promise(async () => {
      let owner: Electron.BrowserWindow | null = null;
      let ownsSaveSlot = false;
      let releaseDocumentListeners: (() => void) | undefined;
      try {
        // Bind the native modal and its pending publication to the validated
        // request sender, not whichever Cafe window happens to be focused later.
        const sender = event.sender;
        if (!sender) return "cancelled";
        owner = Electron.BrowserWindow.fromWebContents(sender as Electron.WebContents);
        if (!owner) return "cancelled";
        if (owner.isDestroyed() || owner.webContents.isDestroyed()) return "cancelled";
        if (pendingSaveOwners.has(owner)) return "failed";
        pendingSaveOwners.add(owner);
        ownsSaveSlot = true;
        const requestingOwner = owner;
        const contents = requestingOwner.webContents;
        const frame = event.senderFrame;
        if (
          !frame ||
          frame.detached !== false ||
          typeof frame.frameToken !== "string" ||
          frame.frameToken.length === 0 ||
          !Number.isInteger(frame.processId) ||
          !Number.isInteger(frame.routingId)
        )
          return "cancelled";
        const documentIdentity = {
          url: frame.url,
          frameToken: frame.frameToken,
          processId: frame.processId,
          routingId: frame.routingId,
        };
        let revoked = false;
        const onNavigation = (
          details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
        ) => {
          if (details.isMainFrame) revoked = true;
        };
        const onRendererExit = () => {
          revoked = true;
        };
        contents.on("did-start-navigation", onNavigation);
        releaseDocumentListeners = () => {
          contents.removeListener("did-start-navigation", onNavigation);
          contents.removeListener("render-process-gone", onRendererExit);
        };
        contents.on("render-process-gone", onRendererExit);
        const isCurrent = () => {
          try {
            if (revoked || requestingOwner.isDestroyed() || contents.isDestroyed()) return false;
            const main = contents.mainFrame;
            return (
              contents === sender &&
              frame.detached === false &&
              main.detached === false &&
              frame.url === documentIdentity.url &&
              contents.getURL() === documentIdentity.url &&
              main.frameToken === documentIdentity.frameToken &&
              main.processId === documentIdentity.processId &&
              main.routingId === documentIdentity.routingId
            );
          } catch {
            return false;
          }
        };
        // A same-URL reload may retain a BrowserWindow/webContents and even a
        // frame wrapper. Navigation-start revocation supplements native frame
        // identity/URL checks so a new document never adopts this old picker.
        if (!isCurrent()) return "cancelled";
        const { bytes } = decodePng(input.png, (png) => Electron.nativeImage.createFromBuffer(png));
        return await savePngFile({
          bytes,
          isCurrent,
          chooseDestination: () =>
            Electron.dialog.showSaveDialog(requestingOwner, {
              title: "Save image",
              defaultPath: input.suggestedName,
              filters: [{ name: "PNG image", extensions: ["png"] }],
              properties: ["createDirectory", "showOverwriteConfirmation"],
            }),
        });
      } catch {
        // Native errors can include destination paths. Cancellation/failure are
        // deliberately finite results; the renderer supplies fixed feedback.
        return "failed";
      } finally {
        try {
          releaseDocumentListeners?.();
        } catch {
          /* No native detail crosses IPC. */
        }
        if (owner && ownsSaveSlot) pendingSaveOwners.delete(owner);
      }
    }),
});

export const savePng = {
  ...savePngMethod,
  handler: (...args: Parameters<typeof savePngMethod.handler>) =>
    savePngMethod.handler(...args).pipe(Effect.catch(() => Effect.succeed("failed" as const))),
};
