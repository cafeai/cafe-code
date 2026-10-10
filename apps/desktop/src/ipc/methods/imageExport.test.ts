import * as Effect from "effect/Effect";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fixturePng } from "../../imageExport/__fixtures__/png.ts";
import { COPY_PNG_CHANNEL, SAVE_PNG_CHANNEL } from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const native = vi.hoisted(() => ({
  createFromBuffer: vi.fn(),
  writeImage: vi.fn(),
  fromWebContents: vi.fn(),
  showSaveDialog: vi.fn(),
}));

vi.mock("electron", () => ({
  nativeImage: { createFromBuffer: native.createFromBuffer },
  clipboard: { writeImage: native.writeImage },
  BrowserWindow: { fromWebContents: native.fromWebContents },
  dialog: { showSaveDialog: native.showSaveDialog },
}));

import { copyPng, savePng } from "./imageExport.ts";

const image = { isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }) };

beforeEach(() => {
  vi.clearAllMocks();
  native.createFromBuffer.mockReturnValue(image);
  native.fromWebContents.mockReturnValue({
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false },
  });
  native.showSaveDialog.mockResolvedValue({ canceled: true });
});

function topFrame(url = "file:///Applications/CafeCode/index.html"): DesktopIpc.DesktopIpcWebFrame {
  const frame = {
    url,
    detached: false,
    frameToken: "fixture-document-token",
    processId: 7,
    routingId: 11,
  } as DesktopIpc.DesktopIpcWebFrame;
  (frame as { top: DesktopIpc.DesktopIpcWebFrame }).top = frame;
  return frame;
}

async function withImageIpc(
  task: (input: {
    readonly invoke: (
      channel: string,
      event: DesktopIpc.DesktopIpcInvokeEvent,
      raw: unknown,
    ) => Promise<unknown>;
    readonly event: DesktopIpc.DesktopIpcInvokeEvent;
  }) => Promise<void>,
): Promise<void> {
  const listeners = new Map<string, DesktopIpc.DesktopIpcHandleListener>();
  const ipc = DesktopIpc.make({
    removeHandler: (channel) => {
      listeners.delete(channel);
    },
    handle: (channel, listener) => {
      listeners.set(channel, listener);
    },
    removeAllListeners: () => undefined,
    on: () => undefined,
  });
  const frame = topFrame();
  const sender = Object.assign(new EventEmitter(), {
    id: 47,
    isDestroyed: () => false,
    mainFrame: frame,
    getURL: () => frame.url,
  });
  native.fromWebContents.mockReturnValue({ isDestroyed: () => false, webContents: sender });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* ipc.trustWebContents(sender);
        yield* ipc.handle(copyPng);
        yield* ipc.handle(savePng);
        yield* Effect.promise(() =>
          task({
            invoke: async (channel, event, raw) => {
              const listener = listeners.get(channel);
              if (!listener) throw new Error("Image IPC fixture was not registered.");
              return await listener(event, raw);
            },
            event: { sender, senderFrame: frame },
          }),
        );
      }),
    ),
  );
}

describe("native PNG IPC", () => {
  it("copies admitted bytes through the write-only native clipboard", async () => {
    await withImageIpc(async ({ invoke, event }) => {
      const png = fixturePng();
      await expect(invoke(COPY_PNG_CHANNEL, event, png)).resolves.toBeUndefined();
      expect(native.createFromBuffer).toHaveBeenCalledExactlyOnceWith(png);
      expect(native.writeImage).toHaveBeenCalledExactlyOnceWith(image);
      expect(native.showSaveDialog).not.toHaveBeenCalled();
    });
  });

  it("rejects malformed payloads and hides arbitrary native clipboard errors", async () => {
    await withImageIpc(async ({ invoke, event }) => {
      for (const png of ["private image text", [137, 80], fixturePng().subarray(0, 20)]) {
        await expect(invoke(COPY_PNG_CHANNEL, event, png)).rejects.toThrow(
          "The image could not be exported.",
        );
      }
      expect(native.createFromBuffer).not.toHaveBeenCalled();
      expect(native.writeImage).not.toHaveBeenCalled();
      native.writeImage.mockImplementationOnce(() => {
        throw new Error("private native clipboard detail");
      });
      await expect(invoke(COPY_PNG_CHANNEL, event, fixturePng())).rejects.toThrow(
        "The image could not be exported.",
      );
    });
  });

  it("binds its picker to the exact validated sender and returns quiet cancellation", async () => {
    await withImageIpc(async ({ invoke, event }) => {
      const owner = native.fromWebContents(event.sender);
      native.fromWebContents.mockClear();
      await expect(
        invoke(SAVE_PNG_CHANNEL, event, { png: fixturePng(), suggestedName: "diagram.png" }),
      ).resolves.toBe("cancelled");
      expect(native.fromWebContents).toHaveBeenCalledExactlyOnceWith(event.sender);
      expect(native.showSaveDialog).toHaveBeenCalledExactlyOnceWith(owner, {
        title: "Save image",
        defaultPath: "diagram.png",
        filters: [{ name: "PNG image", extensions: ["png"] }],
        properties: ["createDirectory", "showOverwriteConfirmation"],
      });
      expect(native.writeImage).not.toHaveBeenCalled();
    });
  });

  it("refuses unsafe default names before decoding or showing a native picker", async () => {
    await withImageIpc(async ({ invoke, event }) => {
      for (const suggestedName of [
        "../private.png",
        "C:\\private.png",
        "image.svg",
        "image\u0000.png",
      ]) {
        await expect(
          invoke(SAVE_PNG_CHANNEL, event, { png: fixturePng(), suggestedName }),
        ).resolves.toBe("failed");
      }
      expect(native.createFromBuffer).not.toHaveBeenCalled();
      expect(native.showSaveDialog).not.toHaveBeenCalled();
    });
  });

  it("revokes save authority when the original requesting window is closed", async () => {
    await withImageIpc(async ({ invoke, event }) => {
      native.fromWebContents.mockReturnValueOnce({
        isDestroyed: () => true,
        webContents: { isDestroyed: () => false },
      });
      await expect(
        invoke(SAVE_PNG_CHANNEL, event, { png: fixturePng(), suggestedName: "table.png" }),
      ).resolves.toBe("cancelled");
      expect(native.showSaveDialog).not.toHaveBeenCalled();
    });
  });

  it("admits only one pending save per requesting window without releasing another request's slot", async () => {
    await withImageIpc(async ({ invoke, event }) => {
      let finishPicker: ((selection: { canceled: boolean }) => void) | undefined;
      native.showSaveDialog.mockImplementationOnce(
        () =>
          new Promise<{ canceled: boolean }>((resolve) => {
            finishPicker = resolve;
          }),
      );
      const input = { png: fixturePng(), suggestedName: "diagram.png" };
      const pending = invoke(SAVE_PNG_CHANNEL, event, input);
      await vi.waitFor(() => expect(native.showSaveDialog).toHaveBeenCalledOnce());
      await expect(invoke(SAVE_PNG_CHANNEL, event, input)).resolves.toBe("failed");
      await expect(invoke(SAVE_PNG_CHANNEL, event, input)).resolves.toBe("failed");
      expect(native.showSaveDialog).toHaveBeenCalledOnce();
      expect(native.createFromBuffer).toHaveBeenCalledOnce();
      if (!finishPicker) throw new Error("Native picker fixture did not start.");
      finishPicker({ canceled: true });
      await expect(pending).resolves.toBe("cancelled");
      await expect(invoke(SAVE_PNG_CHANNEL, event, input)).resolves.toBe("cancelled");
      expect(native.showSaveDialog).toHaveBeenCalledTimes(2);
    });
  });

  it.each(["same-URL reload", "renderer exit", "frame replacement"])(
    "revokes a pending picker for %s without retaining document listeners",
    async (replacement) => {
      await withImageIpc(async ({ invoke, event }) => {
        const sender = event.sender as EventEmitter & { mainFrame: DesktopIpc.DesktopIpcWebFrame };
        native.showSaveDialog.mockImplementationOnce(async () => {
          if (replacement === "same-URL reload")
            sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
          else if (replacement === "renderer exit") sender.emit("render-process-gone");
          else sender.mainFrame = { ...sender.mainFrame, frameToken: "replacement-document-token" };
          // The authority fence runs before interpreting this native path, so
          // this synthetic selection cannot touch the host filesystem.
          return { canceled: false, filePath: "must-not-be-observed.png" };
        });
        await expect(
          invoke(SAVE_PNG_CHANNEL, event, { png: fixturePng(), suggestedName: "diagram.png" }),
        ).resolves.toBe("cancelled");
        expect(sender.listenerCount("did-start-navigation")).toBe(0);
        expect(sender.listenerCount("render-process-gone")).toBe(0);
      });
    },
  );

  it("rejects remote, subframe and unregistered callers before all native work", async () => {
    await withImageIpc(async ({ invoke, event }) => {
      const rejected = [
        { ...event, senderFrame: topFrame("https://evil.example/") },
        { ...event, senderFrame: { url: "file:///private-iframe.html", top: topFrame() } },
        { ...event, sender: { id: 48, isDestroyed: () => false } },
        { ...event, senderFrame: null },
      ];
      for (const invalidEvent of rejected) {
        await expect(invoke(COPY_PNG_CHANNEL, invalidEvent, fixturePng())).rejects.toThrow(
          DesktopIpc.DesktopIpcSenderValidationError,
        );
        await expect(
          invoke(SAVE_PNG_CHANNEL, invalidEvent, {
            png: fixturePng(),
            suggestedName: "diagram.png",
          }),
        ).rejects.toThrow(DesktopIpc.DesktopIpcSenderValidationError);
      }
      expect(native.createFromBuffer).not.toHaveBeenCalled();
      expect(native.writeImage).not.toHaveBeenCalled();
      expect(native.fromWebContents).not.toHaveBeenCalled();
      expect(native.showSaveDialog).not.toHaveBeenCalled();
    });
  });
});
