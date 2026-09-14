import { useEffect, useState } from "react";
import type { EnvironmentId } from "@cafecode/contracts";
import { fileRequest, readBounded } from "../../attachments/fileAttachments";
import { FileAttachmentRequestError } from "../../attachments/fileAttachmentErrors";

// Visible grids admit two captures at a time. Waiting and active requests are
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
  const [value, setValue] = useState<{ src: string | null; error: string | null }>({
    src: null,
    error: null,
  });
  useEffect(() => {
    setValue({ src: null, error: null });
    if (!path) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
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
        objectUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
        setValue({ src: objectUrl, error: null });
      } catch (error) {
        if (!controller.signal.aborted)
          setValue({
            src: null,
            error: error instanceof FileAttachmentRequestError ? error.code : "transfer-failed",
          });
      } finally {
        release?.();
      }
    })();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [environmentId, path, limit, threadId, revision]);
  return { ...value, onError: () => setValue({ src: null, error: "invalid-image" }) };
}
