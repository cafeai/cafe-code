import type { EnvironmentId, ThreadId } from "@cafecode/contracts";
import { VISUALIZATION_POSTER_PATH } from "@cafecode/contracts/visualizationApi";
import type { VisualizationReference } from "@cafecode/contracts/mcpApps";
import { fileRequest, readBounded } from "../../attachments/fileAttachments";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_PIXELS = 1600 * 2000;
const MAX_DECODED_BYTES = 16 * 1024 * 1024;
const MAX_ITEMS = 24;
const MAX_WAITING = 8;
let running = 0;
const waiting: { run: () => void; reject: () => void; signal: AbortSignal; cleanup: () => void }[] =
  [];
const cache = new Map<string, { url: string; blob: Blob; bytes: number; users: number }>();
let retained = 0;

/** Content-free accounting is safe for bounded diagnostics and qualification.
 * These are the allocations owned by this cache, not total Chromium/native RSS.
 * Never expose cache keys, object URLs, source, images or transport credentials.
 */
export function readVisualizationPosterAccounting() {
  return Object.freeze({
    activeTransfers: running,
    queuedTransfers: waiting.length,
    retainedItems: cache.size,
    retainedBytes: retained,
    maxRetainedBytes: MAX_DECODED_BYTES,
  });
}

function collect(required = 0) {
  for (const [key, entry] of cache) {
    if (retained + required <= MAX_DECODED_BYTES && cache.size < MAX_ITEMS) break;
    if (entry.users !== 0) continue;
    cache.delete(key);
    retained -= entry.bytes;
    URL.revokeObjectURL(entry.url);
  }
}

/** Two active transfers/decodes and eight finite waiters, not a history-sized
 * queue. The decoded accounting is conservative RGBA plus encoded bytes.
 * Cache entries are keyed by exact environment/chat/artifact/revision/poster;
 * readers release them on collapse, recycling or transport revocation. */
export async function acquireVisualizationPoster(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  reference: VisualizationReference,
  signal: AbortSignal,
) {
  if (!reference.poster) throw new Error("poster-unavailable");
  const key = JSON.stringify([
    environmentId,
    threadId,
    reference.artifactId,
    reference.revisionId,
    reference.poster.id,
  ]);
  const existing = cache.get(key);
  if (existing) {
    signal.throwIfAborted();
    existing.users += 1;
    return lease(key, existing);
  }
  if (running >= 2) {
    if (waiting.length >= MAX_WAITING) throw new Error("poster-busy");
    await new Promise<void>((resolve, reject) => {
      const item = {
        signal,
        run: resolve,
        reject: () => reject(new Error("poster-cancelled")),
        cleanup: () => signal.removeEventListener("abort", abort),
      };
      const abort = () => {
        const index = waiting.indexOf(item);
        if (index >= 0) {
          waiting.splice(index, 1);
          item.cleanup();
          item.reject();
        }
      };
      waiting.push(item);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  } else running += 1;
  // A woken waiter receives its reserved permit before another fresh request
  // can race its continuation; it must release even if cancellation just won.
  let reservedBytes = 0;
  try {
    signal.throwIfAborted();
    const response = await fileRequest(
      environmentId,
      `${VISUALIZATION_POSTER_PATH}/${reference.artifactId}/${reference.revisionId}`,
      { signal },
      { threadId },
    );
    if (response.headers.get("content-type")?.split(";")[0] !== "image/png")
      throw new Error("poster-unavailable");
    const png = await readBounded(response, MAX_BYTES);
    signal.throwIfAborted();
    // Parse the fixed PNG IHDR before asking Chromium to allocate a bitmap.
    // A declared decompression bomb never reaches the image decoder.
    if (
      png.length < 33 ||
      ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => png[index] === byte)
    )
      throw new Error("poster-unavailable");
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452)
      throw new Error("poster-unavailable");
    const width = view.getUint32(16),
      height = view.getUint32(20);
    if (
      width < 1 ||
      height < 1 ||
      width > 1600 ||
      height > 2000 ||
      width * height > MAX_PIXELS ||
      width !== reference.poster.width ||
      height !== reference.poster.height
    )
      throw new Error("poster-unavailable");
    const bytes = width * height * 4 + png.byteLength;
    collect(bytes);
    if (retained + bytes > MAX_DECODED_BYTES || cache.size >= MAX_ITEMS)
      throw new Error("poster-busy");
    retained += bytes;
    reservedBytes = bytes;
    const blob = new Blob([png as Uint8Array<ArrayBuffer>], { type: "image/png" });
    const bitmap = await createImageBitmap(blob);
    try {
      if (bitmap.width !== width || bitmap.height !== height) throw new Error("poster-unavailable");
    } finally {
      bitmap.close();
    }
    signal.throwIfAborted();
    // A concurrent read may already have populated this same immutable key.
    const raced = cache.get(key);
    if (raced) {
      raced.users += 1;
      return lease(key, raced);
    }
    const entry = { url: URL.createObjectURL(blob), blob, bytes, users: 1 };
    reservedBytes = 0;
    cache.set(key, entry);
    return lease(key, entry);
  } finally {
    retained -= reservedBytes;
    running -= 1;
    while (waiting.length) {
      const next = waiting.shift();
      if (!next) break;
      next.cleanup();
      if (next.signal.aborted) {
        next.reject();
        continue;
      }
      running += 1;
      next.run();
      break;
    }
  }
}

function lease(key: string, entry: { url: string; blob: Blob; bytes: number; users: number }) {
  let released = false;
  return {
    url: entry.url,
    blob: entry.blob,
    release() {
      if (released) return;
      released = true;
      entry.users -= 1;
      // No private bitmap remains globally after its final visible consumer.
      if (entry.users === 0 && cache.get(key) === entry) {
        cache.delete(key);
        retained -= entry.bytes;
        URL.revokeObjectURL(entry.url);
      }
    },
  };
}
