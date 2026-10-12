import {
  CHAT_IMAGES_PATH,
  CHAT_IMAGE_MAX_BYTES,
  CHAT_IMAGE_MAX_PER_MESSAGE,
  ChatImageManifest,
  type ChatImageMetadata,
  type EnvironmentId,
} from "@cafecode/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useRef, useState } from "react";
import { admitImageTransfer } from "../../attachments/imageTransfer";
import { fileRequest, readBounded } from "../../attachments/fileAttachments";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { useDelayedFlag } from "../../hooks/useDelayedFlag";

export interface MarkdownImageContext {
  environmentId: EnvironmentId;
  threadId: string;
  messageId: string;
  isStreaming: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
}

// Only in-flight metadata transfers are shared. Bytes/object URLs never enter
// persistent renderer state, and one mounted image owns its own cancellation.
interface ManifestTransfer {
  promise: Promise<readonly ChatImageMetadata[]>;
  controller: AbortController;
  subscribers: number;
}
const manifests = new Map<string, ManifestTransfer>();
const decodeManifest = Schema.decodeUnknownSync(ChatImageManifest);
function manifest(
  context: Pick<MarkdownImageContext, "environmentId" | "threadId" | "messageId">,
  signal: AbortSignal,
) {
  const key = JSON.stringify([context.environmentId, context.threadId, context.messageId]);
  if (signal.aborted) return Promise.reject(new Error("cancelled"));
  let transfer = manifests.get(key);
  if (!transfer) {
    const controller = new AbortController();
    const promise = (async () => {
      const response = await fileRequest(
        context.environmentId,
        CHAT_IMAGES_PATH,
        { signal: controller.signal },
        {
          threadId: context.threadId,
          messageId: context.messageId,
        },
      );
      const entries = decodeManifest(
        JSON.parse(new TextDecoder().decode(await readBounded(response, 32 * 1024))),
      );
      if (entries.length > CHAT_IMAGE_MAX_PER_MESSAGE) throw new Error("invalid manifest");
      return entries;
    })();
    transfer = { promise, controller, subscribers: 0 };
    manifests.set(key, transfer);
  }
  const shared = transfer;
  shared.subscribers++;
  return new Promise<readonly ChatImageMetadata[]>((resolve, reject) => {
    let attached = true;
    const detach = () => {
      if (!attached) return;
      attached = false;
      signal.removeEventListener("abort", abort);
      shared.subscribers--;
      if (shared.subscribers === 0) {
        // Abort a hidden chat's transfer only when no other mounted image
        // needs it. This also releases the shared transfer slots promptly.
        shared.controller.abort();
        if (manifests.get(key) === shared) manifests.delete(key);
      }
    };
    const abort = () => {
      detach();
      reject(new Error("cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    void shared.promise.then(
      (entries) => {
        detach();
        resolve(entries);
      },
      (error) => {
        detach();
        reject(error);
      },
    );
  });
}

export function MarkdownImage({
  source,
  alt,
  context,
}: {
  source: string;
  alt: string;
  context: MarkdownImageContext;
}) {
  const { environmentId, threadId, messageId, isStreaming, onImageExpand } = context;
  const [revision, setRevision] = useState(0);
  const identity = JSON.stringify([
    environmentId,
    threadId,
    messageId,
    source,
    isStreaming,
    revision,
  ]);
  const [value, setValue] = useState<{
    identity: string;
    src?: string;
    metadata?: ChatImageMetadata;
    failed?: boolean;
  }>({ identity });
  const objectUrl = useRef<string | null>(null);
  const current = value.identity === identity ? value : { identity };
  const loading = useDelayedFlag(!current.src && !current.failed);
  useEffect(() => {
    const controller = new AbortController();
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
    if (isStreaming) return () => controller.abort();
    void (async () => {
      let release: (() => void) | undefined;
      try {
        release = await admitImageTransfer(controller.signal);
        const entries = await manifest({ environmentId, threadId, messageId }, controller.signal);
        if (controller.signal.aborted) return;
        const metadata = entries.find((entry) => entry.source === source);
        if (!metadata || metadata.width * metadata.height > 40_000_000)
          throw new Error("image unavailable");
        setValue({ identity, metadata });
        const response = await fileRequest(
          environmentId,
          CHAT_IMAGES_PATH,
          { signal: controller.signal },
          {
            threadId,
            messageId,
            source,
          },
        );
        if (response.headers.get("content-type")?.split(";", 1)[0] !== metadata.mimeType)
          throw new Error("invalid image");
        const bytes = await readBounded(response, CHAT_IMAGE_MAX_BYTES);
        if (bytes.length !== metadata.sizeBytes) throw new Error("invalid image");
        if (controller.signal.aborted) return;
        const src = URL.createObjectURL(
          new Blob([new Uint8Array(bytes)], { type: metadata.mimeType }),
        );
        objectUrl.current = src;
        setValue({ identity, metadata, src });
      } catch {
        if (!controller.signal.aborted) setValue({ identity, failed: true });
      } finally {
        release?.();
      }
    })();
    return () => {
      controller.abort();
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = null;
    };
  }, [environmentId, threadId, messageId, source, isStreaming, identity]);
  if (current.failed)
    return (
      <span className="my-2 flex items-center gap-2 text-xs text-muted-foreground">
        <span>{alt ? `${alt} · Image unavailable` : "Image unavailable"}</span>
        <button
          type="button"
          className="underline underline-offset-2"
          onClick={() => setRevision((v) => v + 1)}
        >
          Retry
        </button>
      </span>
    );
  return (
    <span
      className="my-2 block max-w-full overflow-hidden rounded-lg border border-border bg-card"
      style={
        current.metadata
          ? {
              aspectRatio: `${current.metadata.width} / ${current.metadata.height}`,
              maxWidth: current.metadata.width,
            }
          : { minHeight: "4rem" }
      }
    >
      {current.src ? (
        <button
          type="button"
          className="block h-full w-full cursor-zoom-in"
          aria-label={`Enlarge ${alt || "image"}`}
          onClick={() =>
            onImageExpand({ images: [{ src: current.src!, name: alt || "Image" }], index: 0 })
          }
        >
          <img
            src={current.src}
            alt={alt}
            width={current.metadata?.width}
            height={current.metadata?.height}
            className="h-full w-full object-contain"
            onError={() => setValue({ identity, failed: true })}
          />
        </button>
      ) : loading ? (
        <span className="flex min-h-16 items-center justify-center text-xs text-muted-foreground">
          {isStreaming ? "Preparing image…" : "Loading image…"}
        </span>
      ) : null}
    </span>
  );
}
