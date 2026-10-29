import { DesktopNotificationInput, DesktopNotificationResult } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Electron from "electron";

import * as IpcChannels from "../channels.ts";
import { DesktopIpc, makeIpcMethod, type DesktopIpcInvokeEvent } from "../DesktopIpc.ts";

const MAX_NOTIFICATIONS = 64;

/** Scoped to desktop IPC, with each native object owned by its exact document. */
export function makeDesktopNotifications() {
  const active = new Set<{
    sender: object;
    tag: string;
    retire: () => void;
  }>();
  const owners = new Map<
    Electron.WebContents,
    { retirements: Set<() => void>; release: () => void }
  >();
  let disposed = false;

  const ownDocument = (sender: Electron.WebContents, retire: () => void) => {
    let owner = owners.get(sender);
    if (!owner) {
      const retirements = new Set<() => void>();
      const onRetire = () => {
        for (const release of retirements) release();
      };
      const onNavigation = (
        details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
      ) => {
        if (details.isMainFrame && !details.isSameDocument) onRetire();
      };
      owner = {
        retirements,
        release: () => {
          sender.removeListener("did-start-navigation", onNavigation);
          sender.removeListener("render-process-gone", onRetire);
          sender.removeListener("destroyed", onRetire);
          owners.delete(sender);
        },
      };
      owners.set(sender, owner);
      sender.on("did-start-navigation", onNavigation);
      sender.on("render-process-gone", onRetire);
      sender.on("destroyed", onRetire);
    }
    const documentOwner = owner;
    documentOwner.retirements.add(retire);
    return () => {
      documentOwner.retirements.delete(retire);
      if (documentOwner.retirements.size === 0) documentOwner.release();
    };
  };

  const show = (input: DesktopNotificationInput, event: DesktopIpcInvokeEvent) =>
    Effect.callback<DesktopNotificationResult>((resume) => {
      let notification: Electron.Notification | undefined;
      let cleanup: (() => void) | undefined;
      let retired = false;
      let settled = false;
      const finish = (result: DesktopNotificationResult) => {
        if (settled) return;
        settled = true;
        resume(Effect.succeed(result));
      };
      const retire = (result: DesktopNotificationResult = "cancelled", close = true) => {
        if (retired) return;
        retired = true;
        active.delete(record);
        cleanup?.();
        finish(result);
        // Native event errors are opaque; never coerce or forward their text.
        try {
          if (close) notification?.close();
        } catch {
          // Ownership is already revoked even if the OS refuses dismissal.
        }
      };
      const record = { sender: event.sender!, tag: input.tag, retire: () => retire() };
      try {
        const sender = event.sender as Electron.WebContents | undefined;
        const frame = event.senderFrame as Electron.WebFrameMain | undefined;
        const owner = sender ? Electron.BrowserWindow.fromWebContents(sender) : null;
        if (
          disposed ||
          !sender ||
          !frame ||
          !owner ||
          owner.isDestroyed() ||
          sender.isDestroyed()
        ) {
          finish("cancelled");
          return;
        }
        if (!Electron.Notification.isSupported()) {
          finish("unsupported");
          return;
        }
        if (
          !frame.frameToken ||
          !Number.isInteger(frame.processId) ||
          !Number.isInteger(frame.routingId)
        ) {
          finish("cancelled");
          return;
        }
        const identity = [frame.frameToken, frame.processId, frame.routingId];
        const isCurrent = () => {
          try {
            return (
              !retired &&
              !owner.isDestroyed() &&
              !sender.isDestroyed() &&
              sender.mainFrame === frame &&
              frame.detached === false &&
              [frame.frameToken, frame.processId, frame.routingId].every(
                (value, index) => value === identity[index],
              )
            );
          } catch {
            // Native frame access can fail during renderer teardown. Failure
            // revokes this notification instead of escaping an event callback.
            return false;
          }
        };
        if (!isCurrent()) {
          finish("cancelled");
          return;
        }
        // Replace only this document's same-tag notification. Keep native
        // objects reachable for click events, but never retain an unbounded set.
        for (const previous of active) {
          if (previous.sender === sender && previous.tag === input.tag) previous.retire();
        }
        if (active.size >= MAX_NOTIFICATIONS) active.values().next().value?.retire();

        // Electron 43.8.4's NotificationPresenterMac requests native alert,
        // sound and badge authorization when first created. Its `show` callback
        // is OS scheduling acceptance, not proof of a visible banner:
        // https://github.com/electron/electron/blob/v43.8.4/shell/browser/notifications/mac/cocoa_notification.mm
        notification = new Electron.Notification({ title: input.title, body: input.body });
        const onShow = () => {
          if (isCurrent()) finish("sent");
          else retire();
        };
        const onFailed = () => retire("failed");
        const onClose = () => retire("cancelled", false);
        const releaseDocument = ownDocument(sender, () => retire());
        const onClick = () => {
          try {
            if (!isCurrent()) return;
            if (owner.isMinimized()) owner.restore();
            owner.show();
            owner.focus();
            // Send to the held native frame, never whichever document/window is
            // focused by the time the user clicks a Notification Center entry.
            if (isCurrent()) frame.send(IpcChannels.NOTIFICATION_CLICK_CHANNEL, input.tag);
          } catch {
            // A closing native window grants no replacement routing authority.
          } finally {
            retire();
          }
        };
        cleanup = () => {
          notification?.removeListener("show", onShow);
          notification?.removeListener("failed", onFailed);
          notification?.removeListener("close", onClose);
          notification?.removeListener("click", onClick);
          releaseDocument();
        };
        notification.on("show", onShow);
        notification.on("failed", onFailed);
        notification.on("close", onClose);
        notification.on("click", onClick);
        active.add(record);
        notification.show();
      } catch {
        retire("failed");
      }
      // Interruption, including the finite OS scheduling deadline, retires only
      // this request. A late native show/click can never revive it.
      return Effect.sync(() => retire());
    }).pipe(
      Effect.timeoutOrElse({
        duration: "10 seconds",
        orElse: () => Effect.succeed("failed" as const),
      }),
    );

  return {
    show,
    dispose: () => {
      disposed = true;
      for (const record of active) record.retire();
    },
  };
}

export const installDesktopNotificationHandlers = Effect.gen(function* () {
  const ipc = yield* DesktopIpc;
  const notifications = yield* Effect.acquireRelease(
    Effect.sync(makeDesktopNotifications),
    (controller) => Effect.sync(controller.dispose),
  );
  const method = makeIpcMethod({
    channel: IpcChannels.SHOW_NOTIFICATION_CHANNEL,
    payload: DesktopNotificationInput,
    result: DesktopNotificationResult,
    handler: notifications.show,
  });
  yield* ipc.handle({
    ...method,
    // Schema/native failures must not expose titles, bodies or raw native errors.
    handler: (raw, event) =>
      method.handler(raw, event).pipe(Effect.catch(() => Effect.succeed("failed"))),
  });
});
