import { CHAT_IMAGE_MAX_BYTES } from "@cafecode/contracts";
import * as Electron from "electron";

import { isTrustedDesktopIpcFrameUrl } from "../ipc/DesktopIpc.ts";

// Electron reserves world 999 for preload. A separate isolated world can read
// the document's blob URLs without using page-modified fetch/stream functions
// or exposing any native clipboard capability to received image documents.
const IMAGE_COPY_WORLD = 1001;
const IMAGE_COPY_TIMEOUT_MS = 15_000;

/** This entire function executes in Chromium, including for authenticated chat
 * images whose original bytes live in blob URLs. Electron's main-process fetch
 * does not support blob:; nativeImage/copyImageAt decode only a still frame.
 * Keep all dependencies explicit so the bundled function can be serialized. */
async function readGif(
  source: string,
  maxBytes: number,
  timeoutMs: number,
  fetchSource: (
    source: string,
    init: RequestInit,
  ) => Promise<Pick<Response, "ok" | "body">> = fetch,
) {
  const response = await fetchSource(source, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok || !response.body) throw new Error("Image unavailable");
  const reader = response.body.getReader();
  // A single fixed buffer also bounds streams made of arbitrarily tiny chunks.
  const bytes = new Uint8Array(maxBytes);
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length < 6) {
        bytes.set(value.subarray(0, Math.min(value.length, 6 - length)), length);
        if (
          length + value.length >= 6 &&
          !(
            bytes[0] === 71 &&
            bytes[1] === 73 &&
            bytes[2] === 70 &&
            bytes[3] === 56 &&
            (bytes[4] === 55 || bytes[4] === 57) &&
            bytes[5] === 97
          )
        )
          return null;
      }
      if (length + value.byteLength > maxBytes) throw new Error("Image too large");
      bytes.set(value, length);
      length += value.byteLength;
    }
    return bytes.slice(0, length).buffer;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function gifBytes(value: unknown): Buffer | undefined {
  if (
    !(value instanceof ArrayBuffer) ||
    value.byteLength < 14 ||
    value.byteLength > CHAT_IMAGE_MAX_BYTES
  )
    return;
  const bytes = Buffer.from(value);
  const signature = bytes.subarray(0, 6).toString("latin1");
  if (signature !== "GIF87a" && signature !== "GIF89a") return;
  const width = bytes.readUInt16LE(6);
  const height = bytes.readUInt16LE(8);
  if (
    width < 1 ||
    height < 1 ||
    width > 16_384 ||
    height > 16_384 ||
    width * height > 40_000_000 ||
    bytes.at(-1) !== 0x3b
  )
    return;
  return bytes;
}

/** One window owns one outstanding read. Navigation, renderer retirement and
 * every newer menu synchronously revoke publication, including same-URL reloads.
 * Nothing reads the user's clipboard or writes an image to a temporary file. */
export function makeImageClipboard(
  contents: Electron.WebContents,
  rendererUrl: URL,
  clipboard: Pick<Electron.Clipboard, "writeBuffer"> = Electron.clipboard,
  platform = process.platform,
) {
  let revision = 0;
  let pending = false;
  let retired = false;
  contents.on("did-start-navigation", () => {
    revision++;
  });
  contents.on("render-process-gone", () => {
    revision++;
  });
  contents.once("destroyed", () => {
    retired = true;
    revision++;
  });

  return {
    capture(params: Electron.ContextMenuParams) {
      const capturedRevision = ++revision;
      const frame = contents.mainFrame;
      const frameToken = frame.frameToken;
      const sourceFrame = params.frame;
      const { srcURL, x, y } = params;
      let used = false;
      const isCurrent = () => {
        try {
          return (
            !retired &&
            revision === capturedRevision &&
            !contents.isDestroyed() &&
            !frame.detached &&
            contents.mainFrame.frameToken === frameToken &&
            isTrustedDesktopIpcFrameUrl(frame.url, rendererUrl)
          );
        } catch {
          return false;
        }
      };

      return async (): Promise<"copied" | "cancelled" | "failed"> => {
        if (used || pending || !isCurrent()) return "cancelled";
        used = true;
        pending = true;
        try {
          // Child/sandbox images keep the existing native copy action; they never
          // authorize reading an image through the main application's document.
          if (sourceFrame !== frame || !/^(blob:|https?:|data:image\/)/i.test(srcURL)) {
            contents.copyImageAt(x, y);
            return "copied";
          }
          const started = performance.now();
          // Use the originating Chromium session for ordinary URLs, preserving
          // its cookies/certificate policy and cross-origin image-copy behavior.
          // Only blob/data sources need the application's isolated world.
          const value: unknown = /^https?:/i.test(srcURL)
            ? await readGif(srcURL, CHAT_IMAGE_MAX_BYTES, IMAGE_COPY_TIMEOUT_MS, (source, init) =>
                contents.session.fetch(source, init),
              )
            : await contents.executeJavaScriptInIsolatedWorld(IMAGE_COPY_WORLD, [
                {
                  code: `(${readGif.toString()})(${JSON.stringify(srcURL)}, ${CHAT_IMAGE_MAX_BYTES}, ${IMAGE_COPY_TIMEOUT_MS})`,
                },
              ]);
          if (!isCurrent()) return "cancelled";
          // Execution itself can be delayed by a busy renderer. Its eventual
          // response cannot renew the original native menu gesture's lifetime.
          if (performance.now() - started >= IMAGE_COPY_TIMEOUT_MS) return "failed";
          if (value === null) {
            contents.copyImageAt(x, y);
          } else {
            const bytes = gifBytes(value);
            if (!bytes) return "failed";
            // These are raw OS formats, not decoded NativeImages. In particular
            // Apple's GIF UTI is com.compuserve.gif, rather than public.gif.
            const format =
              platform === "darwin"
                ? "com.compuserve.gif"
                : platform === "win32"
                  ? "GIF"
                  : "image/gif";
            clipboard.writeBuffer(format, bytes);
          }
          return "copied";
        } catch {
          // Neither source URLs nor native/fetch errors may reach diagnostics.
          // Do not silently substitute a still frame for an unreadable GIF.
          return isCurrent() ? "failed" : "cancelled";
        } finally {
          pending = false;
        }
      };
    },
  };
}
