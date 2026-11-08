import type * as Electron from "electron";
import { EventEmitter } from "node:events";
// Execute the actual isolated-world reader against synthetic browser APIs.
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { CHAT_IMAGE_MAX_BYTES } from "@cafecode/contracts";

import { makeImageClipboard } from "./ImageClipboard.ts";

// Two differently colored frames plus their timing/loop extension. The whole
// encoded file, rather than a decoded frame, must survive the clipboard write.
const GIF = Buffer.from(
  "47494638396101000100800000ff00000000ff21ff0b4e45545343415045322e30030100000021f904000a0000002c000000000100010000020244010021f904000a0000002c00000000010001000002024c01003b",
  "hex",
);
const RENDERER_URL = new URL("http://127.0.0.1:5733/");

function response(bytes: Uint8Array, chunkSize = bytes.length): Response {
  let offset = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.subarray(offset, offset + chunkSize));
        offset = Math.min(bytes.length, offset + chunkSize);
      },
    }),
    // Detection must use the signature even for extensionless or generic URLs.
    { headers: { "content-type": "application/octet-stream" } },
  );
}

function fixture(platform: NodeJS.Platform = "darwin") {
  const frame = { frameToken: "document-1", detached: false, url: RENDERER_URL.href };
  const fetchImage = vi.fn(async () => response(GIF));
  const clipboard = { writeBuffer: vi.fn() };
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: frame,
    isDestroyed: vi.fn(() => false),
    copyImageAt: vi.fn(),
    session: { fetch: fetchImage },
    executeJavaScriptInIsolatedWorld: vi.fn(async (_world: number, scripts: Electron.WebSource[]) =>
      runInNewContext(scripts[0]!.code, {
        fetch: fetchImage,
        AbortSignal,
        Uint8Array,
        ArrayBuffer,
        Error,
      }),
    ),
  });
  const controller = makeImageClipboard(
    contents as unknown as Electron.WebContents,
    RENDERER_URL,
    clipboard,
    platform,
  );
  const params = {
    frame,
    srcURL: "blob:http://127.0.0.1:5733/original-image",
    x: 12,
    y: 34,
    mediaType: "image",
    hasImageContents: true,
  } as unknown as Electron.ContextMenuParams;
  return { contents, clipboard, fetchImage, controller, params };
}

describe("native image context-menu clipboard", () => {
  it.each([
    ["darwin", "com.compuserve.gif"],
    ["win32", "GIF"],
    ["linux", "image/gif"],
  ] as const)("copies every original GIF byte on %s", async (platform, format) => {
    const f = fixture(platform);
    // Exercise signature/header and animation data spanning stream boundaries.
    f.fetchImage.mockImplementationOnce(async () => response(GIF, 1));
    expect(await f.controller.capture(f.params)()).toBe("copied");
    expect(f.clipboard.writeBuffer).toHaveBeenCalledExactlyOnceWith(format, GIF);
    expect(f.contents.copyImageAt).not.toHaveBeenCalled();
    expect(f.contents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledOnce();
  });

  it("reads a remote extensionless image through the exact originating session", async () => {
    const f = fixture();
    f.params.srcURL = "https://images.example/asset?id=123";
    expect(await f.controller.capture(f.params)()).toBe("copied");
    expect(f.fetchImage).toHaveBeenCalledWith(f.params.srcURL, { signal: expect.any(AbortSignal) });
    expect(f.contents.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
    expect(f.clipboard.writeBuffer).toHaveBeenCalledExactlyOnceWith("com.compuserve.gif", GIF);
  });

  it("retains native copying for other image formats and cancels the unread body", async () => {
    const f = fixture();
    const cancel = vi.fn();
    f.fetchImage.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]));
          },
          cancel,
        }),
      ),
    );
    expect(await f.controller.capture(f.params)()).toBe("copied");
    expect(f.contents.copyImageAt).toHaveBeenCalledExactlyOnceWith(12, 34);
    expect(cancel).toHaveBeenCalledOnce();
    expect(f.clipboard.writeBuffer).not.toHaveBeenCalled();
  });

  it("keeps child-frame images outside the application's original-byte reader", async () => {
    const f = fixture();
    f.params.frame = {} as Electron.WebFrameMain;
    expect(await f.controller.capture(f.params)()).toBe("copied");
    expect(f.contents.copyImageAt).toHaveBeenCalledExactlyOnceWith(12, 34);
    expect(f.fetchImage).not.toHaveBeenCalled();
    expect(f.contents.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
    expect(f.clipboard.writeBuffer).not.toHaveBeenCalled();
  });

  it.each(["oversized", "truncated", "invalid-dimensions", "unreadable"])(
    "leaves the clipboard untouched for an %s GIF instead of copying a still frame",
    async (failure) => {
      const f = fixture();
      if (failure === "unreadable") {
        f.fetchImage.mockRejectedValueOnce(new Error("private source and native error"));
      } else {
        const bytes =
          failure === "oversized" ? new Uint8Array(CHAT_IMAGE_MAX_BYTES + 1) : new Uint8Array(GIF);
        bytes.set(GIF.subarray(0, Math.min(GIF.length, bytes.length)));
        if (failure === "truncated") bytes[bytes.length - 1] = 0;
        if (failure === "invalid-dimensions") bytes[6] = bytes[7] = 0;
        f.fetchImage.mockResolvedValueOnce(response(bytes));
      }
      expect(await f.controller.capture(f.params)()).toBe("failed");
      expect(f.clipboard.writeBuffer).not.toHaveBeenCalled();
      expect(f.contents.copyImageAt).not.toHaveBeenCalled();
    },
  );

  it.each(["navigation", "replacement", "new-menu", "renderer-exit", "destroyed"])(
    "revokes an in-flight GIF copy on %s and keeps only one read pending",
    async (retirement) => {
      const f = fixture();
      let finish!: (response: Response) => void;
      f.fetchImage.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const copy = f.controller.capture(f.params);
      const pending = copy();
      expect(await copy()).toBe("cancelled");
      expect(f.fetchImage).toHaveBeenCalledOnce();
      if (retirement === "navigation")
        f.contents.emit("did-start-navigation", { isMainFrame: true });
      if (retirement === "replacement")
        f.contents.mainFrame = { ...f.contents.mainFrame, frameToken: "document-2" };
      if (retirement === "new-menu") f.controller.capture(f.params);
      if (retirement === "renderer-exit") f.contents.emit("render-process-gone");
      if (retirement === "destroyed") f.contents.emit("destroyed");
      finish(response(GIF));
      expect(await pending).toBe("cancelled");
      expect(f.clipboard.writeBuffer).not.toHaveBeenCalled();
      expect(f.contents.copyImageAt).not.toHaveBeenCalled();
    },
  );

  it("refuses a stale menu before starting a read and releases the slot after failure", async () => {
    const f = fixture();
    const stale = f.controller.capture(f.params);
    f.contents.emit("did-start-navigation", { isMainFrame: true });
    expect(await stale()).toBe("cancelled");
    expect(f.fetchImage).not.toHaveBeenCalled();
    f.fetchImage.mockRejectedValueOnce(new Error("failed"));
    expect(await f.controller.capture(f.params)()).toBe("failed");
    expect(await f.controller.capture(f.params)()).toBe("copied");
    expect(f.clipboard.writeBuffer).toHaveBeenCalledExactlyOnceWith("com.compuserve.gif", GIF);
  });

  it("expires a delayed renderer result and admits a later fresh gesture", async () => {
    const f = fixture();
    const now = vi.spyOn(performance, "now");
    try {
      now.mockReturnValueOnce(0).mockReturnValueOnce(15_001);
      expect(await f.controller.capture(f.params)()).toBe("failed");
      expect(f.clipboard.writeBuffer).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
    const copy = f.controller.capture(f.params);
    expect(await copy()).toBe("copied");
    expect(await copy()).toBe("cancelled");
    expect(f.clipboard.writeBuffer).toHaveBeenCalledExactlyOnceWith("com.compuserve.gif", GIF);
  });
});
