import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";

import * as DesktopIpc from "./DesktopIpc.ts";

function makeTopFrame(url: string): DesktopIpc.DesktopIpcWebFrame {
  const frame = {
    url,
    top: null,
  } as DesktopIpc.DesktopIpcWebFrame;
  (frame as { top: DesktopIpc.DesktopIpcWebFrame }).top = frame;
  return frame;
}

function makeIpcMainStub() {
  let invokeListener: DesktopIpc.DesktopIpcHandleListener | null = null;
  let syncListener: DesktopIpc.DesktopIpcSyncListener | null = null;

  return {
    ipcMain: {
      removeHandler: vi.fn(),
      handle: vi.fn((_channel, listener) => {
        invokeListener = listener;
      }),
      removeAllListeners: vi.fn(),
      on: vi.fn((_channel, listener) => {
        syncListener = listener;
      }),
    } satisfies DesktopIpc.DesktopIpcMain,
    getInvokeListener: () => {
      if (!invokeListener) throw new Error("invoke listener not registered");
      return invokeListener;
    },
    getSyncListener: () => {
      if (!syncListener) throw new Error("sync listener not registered");
      return syncListener;
    },
  };
}

describe("DesktopIpc sender validation", () => {
  it("classifies only file and loopback renderer URLs as trusted", () => {
    expect(DesktopIpc.isTrustedDesktopIpcFrameUrl("file:///Applications/CafeCode/index.html")).toBe(
      true,
    );
    expect(DesktopIpc.isTrustedDesktopIpcFrameUrl("http://127.0.0.1:5733/")).toBe(true);
    expect(DesktopIpc.isTrustedDesktopIpcFrameUrl("http://localhost:5733/")).toBe(true);
    expect(DesktopIpc.isTrustedDesktopIpcFrameUrl("http://[::1]:5733/")).toBe(true);
    expect(DesktopIpc.isTrustedDesktopIpcFrameUrl("https://example.com/")).toBe(false);
    expect(DesktopIpc.isTrustedDesktopIpcFrameUrl("app://cafe-code/index.html")).toBe(false);
  });

  it("allows invoke handlers from registered top-level production and dev frames", async () => {
    const ipcMain = makeIpcMainStub();
    const ipc = DesktopIpc.make(ipcMain.ipcMain);
    const sender = { id: 7, isDestroyed: () => false };
    let calls = 0;

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* ipc.trustWebContents(sender);
          yield* ipc.handle({
            channel: "secure.invoke",
            handler: (raw) =>
              Effect.sync(() => {
                calls += 1;
                return raw;
              }),
          });

          yield* Effect.promise(() =>
            Promise.resolve(
              ipcMain.getInvokeListener()(
                { sender, senderFrame: makeTopFrame("file:///Applications/CafeCode/index.html") },
                "production",
              ),
            ),
          );
          yield* Effect.promise(() =>
            Promise.resolve(
              ipcMain.getInvokeListener()(
                { sender, senderFrame: makeTopFrame("http://127.0.0.1:5733/") },
                "development",
              ),
            ),
          );
        }),
      ),
    );

    expect(calls).toBe(2);
  });

  it("rejects invoke handlers from untrusted origins and unexpected frames", async () => {
    const ipcMain = makeIpcMainStub();
    const ipc = DesktopIpc.make(ipcMain.ipcMain);
    const sender = { id: 7, isDestroyed: () => false };
    let calls = 0;

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* ipc.trustWebContents(sender);
          yield* ipc.handle({
            channel: "secure.invoke",
            handler: () =>
              Effect.sync(() => {
                calls += 1;
                return "handled";
              }),
          });
        }),
      ),
    );

    const listener = ipcMain.getInvokeListener();
    const topFrame = makeTopFrame("http://127.0.0.1:5733/");
    const childFrame = { url: "http://127.0.0.1:5733/iframe", top: topFrame };

    await expect(
      listener({ sender, senderFrame: makeTopFrame("https://evil.example/") }, "payload"),
    ).rejects.toThrow(DesktopIpc.DesktopIpcSenderValidationError);
    await expect(listener({ sender, senderFrame: childFrame }, "payload")).rejects.toThrow(
      DesktopIpc.DesktopIpcSenderValidationError,
    );
    await expect(
      listener({ sender: { id: 8, isDestroyed: () => false }, senderFrame: topFrame }, "payload"),
    ).rejects.toThrow(DesktopIpc.DesktopIpcSenderValidationError);
    await expect(listener({ sender, senderFrame: null }, "payload")).rejects.toThrow(
      DesktopIpc.DesktopIpcSenderValidationError,
    );

    expect(calls).toBe(0);
  });

  it("does not execute sync handlers from untrusted senders", async () => {
    const ipcMain = makeIpcMainStub();
    const ipc = DesktopIpc.make(ipcMain.ipcMain);
    let calls = 0;

    await Effect.runPromise(
      Effect.scoped(
        ipc.handleSync({
          channel: "secure.sync",
          handler: () =>
            Effect.sync(() => {
              calls += 1;
              return "secret";
            }),
        }),
      ),
    );

    const event = {
      returnValue: "unset",
      sender: { id: 9, isDestroyed: () => false },
      senderFrame: makeTopFrame("http://127.0.0.1:5733/"),
    };
    ipcMain.getSyncListener()(event);

    expect(event.returnValue).toBeNull();
    expect(calls).toBe(0);
  });
});
