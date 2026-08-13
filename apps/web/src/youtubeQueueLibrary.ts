/**
 * Device-local persistence for named YouTube queues.
 *
 * This module stores canonical video IDs only. It never accepts or persists
 * source URLs, and it does not perform network, embed, artwork, or playback
 * work. Callers must parse imported text before they use this store.
 */

export const YOUTUBE_QUEUE_LIBRARY_STORAGE_KEY = "cafe-code:youtube-queue-library:v1";
export const YOUTUBE_QUEUE_LIBRARY_MAX_BYTES = 128 * 1_024;
export const YOUTUBE_QUEUE_LIBRARY_MAX_QUEUES = 32;
export const YOUTUBE_QUEUE_LIBRARY_MAX_ITEMS_PER_QUEUE = 200;
export const YOUTUBE_QUEUE_LIBRARY_MAX_NAME_CODE_POINTS = 80;
export const YOUTUBE_QUEUE_LIBRARY_MAX_NAME_BYTES = 256;

const YOUTUBE_QUEUE_LIBRARY_VERSION = 1;
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const UNSAFE_NAME_CHARACTER_PATTERN = /[\p{Cc}\p{Cf}\p{Cs}]/u;

export interface SavedYouTubeQueue {
  readonly name: string;
  readonly videoIds: readonly string[];
}

export interface YouTubeQueueLibrarySnapshot {
  readonly queues: readonly SavedYouTubeQueue[];
}

export interface YouTubeQueueLibraryStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
}

export interface YouTubeQueueLibraryExclusiveLock {
  readonly run: <Value>(operation: () => Value) => Promise<Value>;
}

export type YouTubeQueueImportDisposition = "added" | "replaced";

export interface YouTubeQueueImportResult {
  readonly disposition: YouTubeQueueImportDisposition;
  readonly queue: SavedYouTubeQueue;
}

export class YouTubeQueueLibraryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YouTubeQueueLibraryError";
  }
}

function emptySnapshot(): YouTubeQueueLibrarySnapshot {
  return Object.freeze({ queues: Object.freeze([]) });
}

interface DecodedSnapshot {
  readonly valid: boolean;
  readonly snapshot: YouTubeQueueLibrarySnapshot;
}

function invalidSnapshot(): DecodedSnapshot {
  return Object.freeze({ valid: false, snapshot: emptySnapshot() });
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return (
    typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasExactKeys(value: Record<PropertyKey, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function normalizeName(input: string): string {
  if (typeof input !== "string" || input.length > YOUTUBE_QUEUE_LIBRARY_MAX_NAME_BYTES) {
    throw new YouTubeQueueLibraryError("Enter a valid queue name.");
  }
  const name = input.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (
    name.length === 0 ||
    [...name].length > YOUTUBE_QUEUE_LIBRARY_MAX_NAME_CODE_POINTS ||
    utf8ByteLength(name) > YOUTUBE_QUEUE_LIBRARY_MAX_NAME_BYTES ||
    UNSAFE_NAME_CHARACTER_PATTERN.test(name)
  ) {
    throw new YouTubeQueueLibraryError("Enter a valid queue name.");
  }
  return name;
}

function logicalName(name: string): string {
  return name.toLocaleLowerCase("en-US");
}

function normalizeVideoIds(input: readonly string[]): readonly string[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new YouTubeQueueLibraryError("Import a queue that contains at least one video.");
  }
  if (input.length > YOUTUBE_QUEUE_LIBRARY_MAX_ITEMS_PER_QUEUE) {
    throw new YouTubeQueueLibraryError(
      `A queue can contain up to ${YOUTUBE_QUEUE_LIBRARY_MAX_ITEMS_PER_QUEUE} videos.`,
    );
  }

  const videoIds: string[] = [];
  const seen = new Set<string>();
  for (const videoId of input) {
    if (typeof videoId !== "string" || !VIDEO_ID_PATTERN.test(videoId)) {
      throw new YouTubeQueueLibraryError("The queue contains an invalid video ID.");
    }
    if (!seen.has(videoId)) {
      seen.add(videoId);
      videoIds.push(videoId);
    }
  }
  return Object.freeze(videoIds);
}

function freezeQueue(name: string, videoIds: readonly string[]): SavedYouTubeQueue {
  return Object.freeze({ name, videoIds: Object.freeze([...videoIds]) });
}

function decodeSnapshot(raw: string | null): DecodedSnapshot {
  if (raw === null) {
    return Object.freeze({ valid: true, snapshot: emptySnapshot() });
  }
  if (
    raw.length > YOUTUBE_QUEUE_LIBRARY_MAX_BYTES ||
    utf8ByteLength(raw) > YOUTUBE_QUEUE_LIBRARY_MAX_BYTES
  ) {
    return invalidSnapshot();
  }

  try {
    const document = JSON.parse(raw) as unknown;
    if (
      !isRecord(document) ||
      !hasExactKeys(document, ["version", "queues"]) ||
      document.version !== YOUTUBE_QUEUE_LIBRARY_VERSION ||
      !Array.isArray(document.queues) ||
      document.queues.length > YOUTUBE_QUEUE_LIBRARY_MAX_QUEUES
    ) {
      return invalidSnapshot();
    }

    const queues: SavedYouTubeQueue[] = [];
    const names = new Set<string>();
    for (const candidate of document.queues) {
      if (!isRecord(candidate) || !hasExactKeys(candidate, ["name", "videoIds"])) {
        return invalidSnapshot();
      }
      if (typeof candidate.name !== "string" || !Array.isArray(candidate.videoIds)) {
        return invalidSnapshot();
      }

      const name = normalizeName(candidate.name);
      if (name !== candidate.name) return invalidSnapshot();
      const key = logicalName(name);
      if (names.has(key)) return invalidSnapshot();

      const videoIds = normalizeVideoIds(candidate.videoIds);
      if (videoIds.length !== candidate.videoIds.length) return invalidSnapshot();
      names.add(key);
      queues.push(freezeQueue(name, videoIds));
    }
    return Object.freeze({
      valid: true,
      snapshot: Object.freeze({ queues: Object.freeze(queues) }),
    });
  } catch {
    return invalidSnapshot();
  }
}

function browserStorage(): YouTubeQueueLibraryStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function browserExclusiveLock(): YouTubeQueueLibraryExclusiveLock | null {
  if (typeof navigator === "undefined") return null;
  try {
    if (navigator.locks === undefined) return null;
    return {
      run: (operation) =>
        navigator.locks.request(
          YOUTUBE_QUEUE_LIBRARY_STORAGE_KEY,
          { mode: "exclusive" },
          operation,
        ),
    };
  } catch {
    return null;
  }
}

type StorageReadResult =
  | { readonly ok: true; readonly raw: string | null }
  | { readonly ok: false };

function readStorage(storage: YouTubeQueueLibraryStorage | null): StorageReadResult {
  if (storage === null) return Object.freeze({ ok: false });
  try {
    const raw = storage.getItem(YOUTUBE_QUEUE_LIBRARY_STORAGE_KEY);
    return raw === null || typeof raw === "string"
      ? Object.freeze({ ok: true, raw })
      : Object.freeze({ ok: false });
  } catch {
    return Object.freeze({ ok: false });
  }
}

function encodeSnapshot(snapshot: YouTubeQueueLibrarySnapshot): string {
  const encoded = JSON.stringify({
    version: YOUTUBE_QUEUE_LIBRARY_VERSION,
    queues: snapshot.queues,
  });
  if (utf8ByteLength(encoded) > YOUTUBE_QUEUE_LIBRARY_MAX_BYTES) {
    throw new YouTubeQueueLibraryError("The local queue library is full.");
  }
  return encoded;
}

export function createYouTubeQueueLibraryStore(
  storage: YouTubeQueueLibraryStorage | null = browserStorage(),
  lock: YouTubeQueueLibraryExclusiveLock | null = browserExclusiveLock(),
) {
  const initialRead = readStorage(storage);
  let snapshot = initialRead.ok ? decodeSnapshot(initialRead.raw).snapshot : emptySnapshot();
  const listeners = new Set<() => void>();

  const publish = (next: YouTubeQueueLibrarySnapshot): void => {
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const refresh = (): void => {
    const read = readStorage(storage);
    publish(read.ok ? decodeSnapshot(read.raw).snapshot : emptySnapshot());
  };

  const importQueue = async (
    nameInput: string,
    videoIdsInput: readonly string[],
  ): Promise<YouTubeQueueImportResult> => {
    const name = normalizeName(nameInput);
    const videoIds = normalizeVideoIds(videoIdsInput);
    const key = logicalName(name);

    if (storage === null) {
      throw new YouTubeQueueLibraryError("Local queue storage is unavailable.");
    }
    if (lock === null) {
      // localStorage does not provide a compare-and-set operation. Writing
      // without an origin-wide lock can silently discard a queue imported by
      // another window. Browsers without Web Locks stay read-only instead of
      // claiming that an unsafe write succeeded.
      throw new YouTubeQueueLibraryError(
        "This browser cannot safely save the queue. Update the browser or use the desktop app.",
      );
    }

    const mutation = (): YouTubeQueueImportResult => {
      // Read and validate while the exclusive lock is held. A second window
      // can write before this operation starts, but it cannot write between
      // this read and the single atomic localStorage replacement. A failed
      // read or corrupt document must not be replaced implicitly because it
      // can contain data that another window can still recover.
      const read = readStorage(storage);
      if (!read.ok) {
        throw new YouTubeQueueLibraryError("The local queue library could not be read.");
      }
      const decoded = decodeSnapshot(read.raw);
      if (!decoded.valid) {
        throw new YouTubeQueueLibraryError(
          "The saved queue library is invalid. Clear it before you import a queue.",
        );
      }
      publish(decoded.snapshot);
      const existingIndex = snapshot.queues.findIndex((queue) => logicalName(queue.name) === key);
      if (existingIndex === -1 && snapshot.queues.length >= YOUTUBE_QUEUE_LIBRARY_MAX_QUEUES) {
        throw new YouTubeQueueLibraryError(
          `You can save up to ${YOUTUBE_QUEUE_LIBRARY_MAX_QUEUES} queues.`,
        );
      }

      const disposition: YouTubeQueueImportDisposition =
        existingIndex === -1 ? "added" : "replaced";
      const queue = freezeQueue(
        existingIndex === -1 ? name : snapshot.queues[existingIndex]!.name,
        videoIds,
      );
      const queues = [...snapshot.queues];
      if (existingIndex === -1) queues.push(queue);
      else queues[existingIndex] = queue;
      const next = Object.freeze({ queues: Object.freeze(queues) });
      const encoded = encodeSnapshot(next);

      try {
        storage.setItem(YOUTUBE_QUEUE_LIBRARY_STORAGE_KEY, encoded);
      } catch {
        throw new YouTubeQueueLibraryError("The queue could not be saved to local storage.");
      }

      // localStorage writes are synchronous, so the value must be readable
      // before this operation reports success. This check also fails closed
      // for storage adapters that silently ignore or alter a write.
      const verification = readStorage(storage);
      if (!verification.ok || verification.raw !== encoded) {
        throw new YouTubeQueueLibraryError("The saved queue could not be verified.");
      }
      publish(next);
      return Object.freeze({ disposition, queue });
    };

    return lock.run(mutation);
  };

  return Object.freeze({
    getSnapshot: (): YouTubeQueueLibrarySnapshot => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    importQueue,
  });
}

export const youtubeQueueLibraryStore = createYouTubeQueueLibraryStore();
