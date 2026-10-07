import { useEffect, useRef, useState } from "react";
import type { EnvironmentId } from "@cafecode/contracts";
import { fileRequest, readBounded } from "../../attachments/fileAttachments";
import { FileAttachmentRequestError } from "../../attachments/fileAttachmentErrors";

// Saved images admit two transfers at a time. Waiting and active requests are
// cancelled on unmount; PNGs never enter persisted renderer/query state.
let active = 0;
const waiting = new Set<() => void>();
function pump() {
  for (let slots = 2 - active; slots > 0 && waiting.size; slots--)
    waiting.values().next().value?.();
}
function admit(signal: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("cancelled"));
      return;
    }
    const abort = () => {
      waiting.delete(ready);
      reject(new Error("cancelled"));
    };
    const ready = () => {
      waiting.delete(ready);
      signal.removeEventListener("abort", abort);
      active++;
      resolve(() => {
        active--;
        pump();
      });
    };
    waiting.add(ready);
    signal.addEventListener("abort", abort, { once: true });
    pump();
  });
}
export function useDesktopImage(
  environmentId: EnvironmentId,
  path: string | null,
  limit: number,
  threadId?: string,
  revision = 0,
) {
  // A different image must never show the previous one, but a refresh of the
  // same image (only `revision` changed) keeps the current frame on screen
  // until the replacement has loaded, so previews don't flash "Loading…".
  const identity = `${environmentId}\u0000${path ?? ""}\u0000${threadId ?? ""}\u0000${limit}`;
  const [value, setValue] = useState<{
    identity: string;
    src: string | null;
    error: string | null;
  }>({ identity, src: null, error: null });
  const displayedUrl = useRef<{ identity: string; url: string } | null>(null);
  const current = value.identity === identity ? value : { identity, src: null, error: null };

  useEffect(() => {
    // Clear a stale error (e.g. on Retry) while keeping any frame of this
    // same image; a new identity starts empty.
    setValue((previous) =>
      previous.identity === identity
        ? previous.error === null
          ? previous
          : { ...previous, error: null }
        : { identity, src: null, error: null },
    );
    // A frame of a different image is never shown again; release it now.
    if (displayedUrl.current && displayedUrl.current.identity !== identity) {
      URL.revokeObjectURL(displayedUrl.current.url);
      displayedUrl.current = null;
    }
    if (!path) return;
    const controller = new AbortController();
    void (async () => {
      let release: (() => void) | undefined;
      try {
        release = await admit(controller.signal);
        const response = await fileRequest(
          environmentId,
          path,
          { signal: controller.signal, cache: "no-store" },
          threadId ? { threadId } : undefined,
        );
        const bytes = await readBounded(response, limit);
        if (controller.signal.aborted) return;
        if (response.headers.get("content-type")?.split(";", 1)[0] !== "image/png")
          throw new Error("invalid image");
        const objectUrl = URL.createObjectURL(
          new Blob([new Uint8Array(bytes)], { type: "image/png" }),
        );
        // Release the replaced frame only once its successor is ready.
        const replaced = displayedUrl.current;
        displayedUrl.current = { identity, url: objectUrl };
        if (replaced) URL.revokeObjectURL(replaced.url);
        setValue({ identity, src: objectUrl, error: null });
      } catch (error) {
        if (!controller.signal.aborted)
          setValue((previous) => ({
            identity,
            // A failed refresh keeps the last frame of the same image.
            src: previous.identity === identity ? previous.src : null,
            error: error instanceof FileAttachmentRequestError ? error.code : "transfer-failed",
          }));
      } finally {
        release?.();
      }
    })();
    return () => controller.abort();
  }, [environmentId, path, limit, threadId, revision, identity]);

  useEffect(
    () => () => {
      if (displayedUrl.current) URL.revokeObjectURL(displayedUrl.current.url);
      displayedUrl.current = null;
    },
    [],
  );

  return {
    src: current.src,
    error: current.error,
    onError: () => setValue({ identity, src: null, error: "invalid-image" }),
  };
}
