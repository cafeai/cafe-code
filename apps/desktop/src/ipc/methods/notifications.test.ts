import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { it as effectIt } from "@effect/vitest";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as DesktopIpc from "../DesktopIpc.ts";
import { NOTIFICATION_CLICK_CHANNEL, SHOW_NOTIFICATION_CHANNEL } from "../channels.ts";

const native = vi.hoisted(() => ({ supported: vi.fn(), create: vi.fn(), owner: vi.fn() }));
vi.mock("electron", () => ({
  Notification: Object.assign(
    function Notification(options: unknown) {
      return native.create(options);
    },
    { isSupported: native.supported },
  ),
  BrowserWindow: { fromWebContents: native.owner },
}));

import { installDesktopNotificationHandlers, makeDesktopNotifications } from "./notifications.ts";

const input = { title: "Opaque chat 日本語", body: "Finished running", tag: "test-owned-chat" };
type FakeNotification = EventEmitter & {
  show: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};
let notifications: FakeNotification[];
beforeEach(() => {
  vi.resetAllMocks();
  notifications = [];
  native.supported.mockReturnValue(true);
  native.create.mockImplementation(() => {
    const notification = new EventEmitter() as FakeNotification;
    notification.show = vi.fn(() => notification.emit("show"));
    notification.close = vi.fn(() => notification.emit("close"));
    notifications.push(notification);
    return notification;
  });
});

async function withIpc(
  task: (fixture: {
    invoke: (raw?: unknown, event?: DesktopIpc.DesktopIpcInvokeEvent) => Promise<unknown>;
    contents: EventEmitter & {
      mainFrame: DesktopIpc.DesktopIpcWebFrame;
      isDestroyed: () => boolean;
    };
    frame: DesktopIpc.DesktopIpcWebFrame & { send: ReturnType<typeof vi.fn> };
    owner: {
      show: ReturnType<typeof vi.fn>;
      focus: ReturnType<typeof vi.fn>;
      restore: ReturnType<typeof vi.fn>;
    };
  }) => Promise<void>,
  role: "main" | "dictation" = "main",
) {
  const frame = {
    url: "http://127.0.0.1:5733/",
    detached: false,
    frameToken: "owned-document",
    processId: 7,
    routingId: 11,
    send: vi.fn(),
  } as DesktopIpc.DesktopIpcWebFrame & { send: ReturnType<typeof vi.fn> };
  Object.assign(frame, { top: frame });
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: frame,
    isDestroyed: () => false,
  });
  const owner = {
    webContents: contents,
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  };
  native.owner.mockImplementation((sender) => (sender === contents ? owner : null));
  let handler: DesktopIpc.DesktopIpcHandleListener | undefined;
  const ipc = DesktopIpc.make({
    handle: (channel, listener) => {
      expect(channel).toBe(SHOW_NOTIFICATION_CHANNEL);
      handler = listener;
    },
    removeHandler: () => {},
    on: () => {},
    removeAllListeners: () => {},
  });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* ipc.trustWebContents(contents, { url: new URL(frame.url), role });
        yield* installDesktopNotificationHandlers.pipe(
          Effect.provideService(DesktopIpc.DesktopIpc, ipc),
        );
        yield* Effect.promise(() =>
          task({
            invoke: (raw = input, event = { sender: contents, senderFrame: contents.mainFrame }) =>
              Promise.resolve(handler!(event, raw)),
            contents,
            frame,
            owner,
          }),
        );
      }),
    ),
  );
  for (const notification of notifications) expect(notification.eventNames()).toEqual([]);
}

describe("trusted native desktop notifications", () => {
  effectIt.effect("expires pending scheduling and fences the original late native callbacks", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const admitted = Promise.withResolvers<void>();
        native.create.mockImplementationOnce(() => {
          const notification = new EventEmitter() as FakeNotification;
          notification.show = vi.fn(() => admitted.resolve());
          notification.close = vi.fn();
          notifications.push(notification);
          return notification;
        });
        const frame = {
          url: "http://127.0.0.1:5733/",
          detached: false,
          frameToken: "timeout-document",
          processId: 7,
          routingId: 11,
          send: vi.fn(),
        };
        const sender = Object.assign(new EventEmitter(), {
          mainFrame: frame,
          isDestroyed: () => false,
        });
        const focus = vi.fn();
        native.owner.mockReturnValue({
          isDestroyed: () => false,
          isMinimized: () => false,
          show: vi.fn(),
          focus,
        });
        const controller = yield* Effect.acquireRelease(
          Effect.sync(makeDesktopNotifications),
          (value) => Effect.sync(value.dispose),
        );
        const fiber = yield* Effect.forkChild(
          controller.show(input, { sender, senderFrame: frame }),
        );
        yield* Effect.promise(() => admitted.promise);
        const lateShow = notifications[0]!.listeners("show")[0]!;
        const lateClick = notifications[0]!.listeners("click")[0]!;
        yield* TestClock.adjust("10 seconds");
        expect(yield* Fiber.join(fiber)).toBe("failed");
        lateShow();
        lateClick();
        expect(notifications[0]!.close).toHaveBeenCalledOnce();
        expect(notifications[0]!.eventNames()).toEqual([]);
        expect(focus).not.toHaveBeenCalled();
        expect(frame.send).not.toHaveBeenCalled();
      }),
    ),
  );
  it("sends natively and restores only its exact owner on a one-shot click", async () => {
    await withIpc(async ({ invoke, frame, owner }) => {
      await expect(invoke()).resolves.toBe("sent");
      expect(native.create).toHaveBeenCalledExactlyOnceWith({
        title: input.title,
        body: input.body,
      });
      expect(owner.focus).not.toHaveBeenCalled();
      // Ordinary SPA navigation retains this document's notification ownership.
      Object.assign(frame, { url: "http://127.0.0.1:5733/another-chat" });
      notifications[0]!.emit("click");
      notifications[0]!.emit("click");
      expect(owner.restore).toHaveBeenCalledOnce();
      expect(owner.show).toHaveBeenCalledOnce();
      expect(owner.focus).toHaveBeenCalledOnce();
      expect(frame.send).toHaveBeenCalledExactlyOnceWith(NOTIFICATION_CLICK_CHANNEL, input.tag);
    });
  });

  it.each(["navigation", "renderer-exit", "destroyed", "replaced-frame"] as const)(
    "revokes late clicks after %s without focusing a replacement",
    async (replacement) => {
      await withIpc(async ({ invoke, contents, frame, owner }) => {
        await invoke();
        const staleClick = notifications[0]!.listeners("click")[0]!;
        if (replacement === "navigation")
          contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
        if (replacement === "renderer-exit") contents.emit("render-process-gone");
        if (replacement === "destroyed") contents.emit("destroyed");
        if (replacement === "replaced-frame")
          contents.mainFrame = { ...frame, frameToken: "replacement" };
        staleClick();
        expect(owner.focus).not.toHaveBeenCalled();
        expect(frame.send).not.toHaveBeenCalled();
        expect(notifications[0]!.close).toHaveBeenCalledOnce();
      });
    },
  );

  it("replaces only same-owner tags and bounds retained native objects", async () => {
    await withIpc(async ({ invoke }) => {
      await invoke();
      await invoke();
      expect(notifications[0]!.close).toHaveBeenCalledOnce();
      for (let index = 0; index < 65; index++) await invoke({ ...input, tag: `bounded-${index}` });
      expect(
        notifications.filter((notification) => notification.listenerCount("click") > 0),
      ).toHaveLength(64);
    });
    expect(notifications.every((notification) => notification.close.mock.calls.length === 1)).toBe(
      true,
    );
  });

  it("maps native failures to finite feedback without coercing opaque errors", async () => {
    const opaque = {
      toString: vi.fn(() => {
        throw new Error("must not coerce");
      }),
    };
    native.create.mockImplementationOnce(() => {
      throw opaque;
    });
    await withIpc(async ({ invoke }) => {
      await expect(invoke()).resolves.toBe("failed");
      native.create.mockImplementationOnce(() => {
        const notification = new EventEmitter() as FakeNotification;
        notification.show = vi.fn(() => notification.emit("failed", {}, opaque));
        notification.close = vi.fn();
        notifications.push(notification);
        return notification;
      });
      await expect(invoke()).resolves.toBe("failed");
      native.supported.mockReturnValue(false);
      await expect(invoke()).resolves.toBe("unsupported");
      expect(native.create).toHaveBeenCalledTimes(2);
    });
    expect(opaque.toString).not.toHaveBeenCalled();
  });

  it("retires a pending native scheduling request before late delivery", async () => {
    const admitted = Promise.withResolvers<void>();
    native.create.mockImplementationOnce(() => {
      const notification = new EventEmitter() as FakeNotification;
      notification.show = vi.fn(() => admitted.resolve());
      notification.close = vi.fn();
      notifications.push(notification);
      return notification;
    });
    await withIpc(async ({ invoke, contents, owner }) => {
      const pending = invoke();
      await admitted.promise;
      const lateShow = notifications[0]!.listeners("show")[0]!;
      const lateClick = notifications[0]!.listeners("click")[0]!;
      contents.emit("render-process-gone");
      await expect(pending).rejects.toThrow(DesktopIpc.DesktopIpcSenderValidationError);
      lateShow();
      lateClick();
      expect(owner.focus).not.toHaveBeenCalled();
      expect(notifications[0]!.close).toHaveBeenCalledOnce();
    });
  });

  it("refuses untrusted frames and invalid payloads before native creation", async () => {
    await withIpc(async ({ invoke, contents, frame }) => {
      await expect(
        invoke(input, { sender: contents, senderFrame: { ...frame, top: frame } }),
      ).rejects.toThrow();
      await expect(invoke(input, { sender: {}, senderFrame: frame })).rejects.toThrow();
      await expect(invoke({ ...input, body: "x".repeat(1025) })).resolves.toBe("failed");
      await expect(invoke({ ...input, tag: "" })).resolves.toBe("failed");
      expect(native.create).not.toHaveBeenCalled();
    });
    await withIpc(async ({ invoke }) => {
      await expect(invoke()).rejects.toThrow();
      expect(native.create).not.toHaveBeenCalled();
    }, "dictation");
  });
});
