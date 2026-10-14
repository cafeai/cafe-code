import { describe, expect, it, vi } from "vitest";

import {
  createYouTubeQueueLibraryStore,
  YOUTUBE_QUEUE_LIBRARY_MAX_BYTES,
  YOUTUBE_QUEUE_LIBRARY_MAX_ITEMS_PER_QUEUE,
  YOUTUBE_QUEUE_LIBRARY_MAX_NAME_CODE_POINTS,
  YOUTUBE_QUEUE_LIBRARY_MAX_QUEUES,
  YOUTUBE_QUEUE_LIBRARY_STORAGE_KEY,
  type YouTubeQueueLibraryExclusiveLock,
  type YouTubeQueueLibraryStorage,
} from "./youtubeQueueLibrary";

function createStorage(initial: string | null = null) {
  let value = initial;
  const storage: YouTubeQueueLibraryStorage = {
    getItem: (key) => (key === YOUTUBE_QUEUE_LIBRARY_STORAGE_KEY ? value : null),
    setItem: (key, next) => {
      expect(key).toBe(YOUTUBE_QUEUE_LIBRARY_STORAGE_KEY);
      value = next;
    },
  };
  return { storage, read: () => value };
}

function videoId(index: number): string {
  return index.toString(36).padStart(11, "0");
}

function createSerializedLibrary(
  queues: readonly { readonly name: string; readonly videoIds: readonly string[] }[],
): string {
  return JSON.stringify({ version: 1, queues });
}

function createSerializedExclusiveLock(lockCalls: string[]): YouTubeQueueLibraryExclusiveLock {
  let tail = Promise.resolve();
  return {
    run: async <Value>(operation: () => Value): Promise<Value> => {
      lockCalls.push("requested");
      const previous = tail;
      let release: (() => void) | undefined;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return operation();
      } finally {
        release?.();
      }
    },
  };
}

const immediateExclusiveLock: YouTubeQueueLibraryExclusiveLock = {
  run: async <Value>(operation: () => Value): Promise<Value> => operation(),
};

describe("YouTube queue library", () => {
  it("adds a normalized immutable queue and persists video IDs only", async () => {
    const backing = createStorage();
    const store = createYouTubeQueueLibraryStore(backing.storage, immediateExclusiveLock);

    const result = await store.importQueue("  \uff2d\uff49\uff58\t  \u97f3\u697d  ", [
      "AAAAAAAAAAA",
      "BBBBBBBBBBB",
      "AAAAAAAAAAA",
    ]);

    expect(result).toEqual({
      disposition: "added",
      queue: { name: "Mix \u97f3\u697d", videoIds: ["AAAAAAAAAAA", "BBBBBBBBBBB"] },
    });
    expect(store.getSnapshot()).toEqual({ queues: [result.queue] });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.queue)).toBe(true);
    expect(Object.isFrozen(result.queue.videoIds)).toBe(true);
    expect(Object.isFrozen(store.getSnapshot())).toBe(true);
    expect(Object.isFrozen(store.getSnapshot().queues)).toBe(true);

    const persisted = backing.read();
    expect(persisted).not.toBeNull();
    expect(persisted).toContain("AAAAAAAAAAA");
    expect(persisted).not.toContain("youtube.com");
    expect(persisted).not.toContain("youtu.be");
    expect(JSON.parse(persisted!)).toEqual({
      version: 1,
      queues: [{ name: "Mix \u97f3\u697d", videoIds: ["AAAAAAAAAAA", "BBBBBBBBBBB"] }],
    });
  });

  it("atomically replaces a same-logical-name import and preserves its library position", async () => {
    const backing = createStorage();
    const store = createYouTubeQueueLibraryStore(backing.storage, immediateExclusiveLock);
    await store.importQueue("Focus Mix", ["AAAAAAAAAAA"]);
    await store.importQueue("Later", ["BBBBBBBBBBB"]);
    const before = backing.read();
    const listener = vi.fn();
    store.subscribe(listener);

    const result = await store.importQueue("  FOCUS   MIX ", ["CCCCCCCCCCC"]);

    expect(result).toEqual({
      disposition: "replaced",
      queue: { name: "Focus Mix", videoIds: ["CCCCCCCCCCC"] },
    });
    expect(store.getSnapshot().queues).toEqual([
      { name: "Focus Mix", videoIds: ["CCCCCCCCCCC"] },
      { name: "Later", videoIds: ["BBBBBBBBBBB"] },
    ]);
    expect(backing.read()).not.toBe(before);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("adds unique names instead of replacing another queue", async () => {
    const backing = createStorage();
    const store = createYouTubeQueueLibraryStore(backing.storage, immediateExclusiveLock);

    await store.importQueue("Morning", ["AAAAAAAAAAA"]);
    const result = await store.importQueue("Evening", ["BBBBBBBBBBB"]);

    expect(result.disposition).toBe("added");
    expect(store.getSnapshot().queues.map(({ name }) => name)).toEqual(["Morning", "Evening"]);
  });

  it("rereads under the shared exclusive lock so two windows keep both imports", async () => {
    const backing = createStorage();
    const lockCalls: string[] = [];
    const lock = createSerializedExclusiveLock(lockCalls);
    const firstWindow = createYouTubeQueueLibraryStore(backing.storage, lock);
    const secondWindow = createYouTubeQueueLibraryStore(backing.storage, lock);

    await Promise.all([
      firstWindow.importQueue("First", ["AAAAAAAAAAA"]),
      secondWindow.importQueue("Second", ["BBBBBBBBBBB"]),
    ]);
    firstWindow.refresh();

    expect(lockCalls).toEqual(["requested", "requested"]);
    expect(firstWindow.getSnapshot().queues.map(({ name }) => name)).toEqual(["First", "Second"]);
  });

  it("keeps storage read-only when an origin-wide lock is unavailable", async () => {
    const backing = createStorage();
    const store = createYouTubeQueueLibraryStore(backing.storage, null);

    await expect(store.importQueue("New", ["AAAAAAAAAAA"])).rejects.toThrow(
      "This browser cannot safely save the queue. Update the browser or use the desktop app.",
    );
    expect(backing.read()).toBeNull();
    expect(store.getSnapshot()).toEqual({ queues: [] });
  });

  it("does not write when lock acquisition fails", async () => {
    const backing = createStorage();
    const lock: YouTubeQueueLibraryExclusiveLock = {
      run: async () => {
        throw new Error("lock unavailable");
      },
    };
    const store = createYouTubeQueueLibraryStore(backing.storage, lock);

    await expect(store.importQueue("New", ["AAAAAAAAAAA"])).rejects.toThrow("lock unavailable");
    expect(backing.read()).toBeNull();
  });

  it.each([
    ["malformed JSON", "{"],
    ["wrong version", JSON.stringify({ version: 2, queues: [] })],
    ["unknown document field", JSON.stringify({ version: 1, queues: [], rawUrl: "secret" })],
    [
      "unknown queue field",
      JSON.stringify({
        version: 1,
        queues: [{ name: "One", videoIds: ["AAAAAAAAAAA"], sourceUrl: "secret" }],
      }),
    ],
    [
      "non-canonical name",
      createSerializedLibrary([{ name: "  One  ", videoIds: ["AAAAAAAAAAA"] }]),
    ],
    [
      "duplicate logical name",
      createSerializedLibrary([
        { name: "One", videoIds: ["AAAAAAAAAAA"] },
        { name: "ONE", videoIds: ["BBBBBBBBBBB"] },
      ]),
    ],
    ["invalid video ID", createSerializedLibrary([{ name: "One", videoIds: ["not-an-id"] }])],
    [
      "duplicate video ID",
      createSerializedLibrary([{ name: "One", videoIds: ["AAAAAAAAAAA", "AAAAAAAAAAA"] }]),
    ],
  ])("fails closed for %s", (_description, raw) => {
    const store = createYouTubeQueueLibraryStore(
      createStorage(raw).storage,
      immediateExclusiveLock,
    );

    expect(store.getSnapshot()).toEqual({ queues: [] });
    expect(Object.isFrozen(store.getSnapshot())).toBe(true);
    expect(Object.isFrozen(store.getSnapshot().queues)).toBe(true);
  });

  it("fails closed for a document above the byte bound", () => {
    const raw = "x".repeat(YOUTUBE_QUEUE_LIBRARY_MAX_BYTES + 1);
    const store = createYouTubeQueueLibraryStore(
      createStorage(raw).storage,
      immediateExclusiveLock,
    );

    expect(store.getSnapshot()).toEqual({ queues: [] });
  });

  it("does not overwrite a corrupt document during import", async () => {
    const backing = createStorage("{");
    const store = createYouTubeQueueLibraryStore(backing.storage, immediateExclusiveLock);

    await expect(store.importQueue("New", ["AAAAAAAAAAA"])).rejects.toThrow(
      "The saved queue library is invalid. Clear it before you import a queue.",
    );
    expect(backing.read()).toBe("{");
    expect(store.getSnapshot()).toEqual({ queues: [] });
  });

  it("does not write when the latest library read fails", async () => {
    const setItem = vi.fn();
    const storage: YouTubeQueueLibraryStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem,
    };
    const store = createYouTubeQueueLibraryStore(storage, immediateExclusiveLock);

    await expect(store.importQueue("New", ["AAAAAAAAAAA"])).rejects.toThrow(
      "The local queue library could not be read.",
    );
    expect(setItem).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toEqual({ queues: [] });
  });

  it("rejects unsafe names and invalid queue input before persistence", async () => {
    const backing = createStorage();
    const store = createYouTubeQueueLibraryStore(backing.storage, immediateExclusiveLock);

    await expect(store.importQueue("", ["AAAAAAAAAAA"])).rejects.toThrow(
      "Enter a valid queue name.",
    );
    await expect(store.importQueue("bad\u0000name", ["AAAAAAAAAAA"])).rejects.toThrow(
      "Enter a valid queue name.",
    );
    await expect(
      store.importQueue("x".repeat(YOUTUBE_QUEUE_LIBRARY_MAX_NAME_CODE_POINTS + 1), [
        "AAAAAAAAAAA",
      ]),
    ).rejects.toThrow("Enter a valid queue name.");
    await expect(store.importQueue("Empty", [])).rejects.toThrow(
      "Import a queue that contains at least one video.",
    );
    await expect(store.importQueue("Bad", ["https://youtu.be/AAAAAAAAAAA"])).rejects.toThrow(
      "The queue contains an invalid video ID.",
    );
    await expect(
      store.importQueue(
        "Too many",
        Array.from({ length: YOUTUBE_QUEUE_LIBRARY_MAX_ITEMS_PER_QUEUE + 1 }, (_, index) =>
          videoId(index),
        ),
      ),
    ).rejects.toThrow(
      `A queue can contain up to ${YOUTUBE_QUEUE_LIBRARY_MAX_ITEMS_PER_QUEUE} videos.`,
    );
    expect(backing.read()).toBeNull();
  });

  it("does not publish a replacement when the atomic storage write fails", async () => {
    const backing = createStorage();
    const store = createYouTubeQueueLibraryStore(backing.storage, immediateExclusiveLock);
    await store.importQueue("Keep", ["AAAAAAAAAAA"]);
    const before = store.getSnapshot();
    const failingStorage: YouTubeQueueLibraryStorage = {
      getItem: backing.storage.getItem,
      setItem: () => {
        throw new Error("quota");
      },
    };
    const failingStore = createYouTubeQueueLibraryStore(failingStorage, immediateExclusiveLock);
    const listener = vi.fn();
    failingStore.subscribe(listener);

    await expect(failingStore.importQueue("Keep", ["BBBBBBBBBBB"])).rejects.toThrow(
      "The queue could not be saved to local storage.",
    );
    expect(failingStore.getSnapshot()).toEqual(before);
    expect(backing.read()).toContain("AAAAAAAAAAA");
    expect(backing.read()).not.toContain("BBBBBBBBBBB");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not publish an unverified write", async () => {
    const backing = createStorage();
    const storage: YouTubeQueueLibraryStorage = {
      getItem: backing.storage.getItem,
      setItem: () => undefined,
    };
    const store = createYouTubeQueueLibraryStore(storage, immediateExclusiveLock);
    const listener = vi.fn();
    store.subscribe(listener);

    await expect(store.importQueue("New", ["AAAAAAAAAAA"])).rejects.toThrow(
      "The saved queue could not be verified.",
    );
    expect(backing.read()).toBeNull();
    expect(store.getSnapshot()).toEqual({ queues: [] });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a storage adapter returns a non-string document", async () => {
    const setItem = vi.fn();
    const storage: YouTubeQueueLibraryStorage = {
      getItem: (() => 42) as unknown as YouTubeQueueLibraryStorage["getItem"],
      setItem,
    };
    const store = createYouTubeQueueLibraryStore(storage, immediateExclusiveLock);

    expect(store.getSnapshot()).toEqual({ queues: [] });
    await expect(store.importQueue("New", ["AAAAAAAAAAA"])).rejects.toThrow(
      "The local queue library could not be read.",
    );
    expect(setItem).not.toHaveBeenCalled();
  });

  it("enforces the queue count before it writes", async () => {
    const backing = createStorage();
    const store = createYouTubeQueueLibraryStore(backing.storage, immediateExclusiveLock);
    for (let index = 0; index < YOUTUBE_QUEUE_LIBRARY_MAX_QUEUES; index += 1) {
      await store.importQueue(`Queue ${index}`, [videoId(index)]);
    }
    const before = backing.read();

    await expect(store.importQueue("One too many", ["ZZZZZZZZZZZ"])).rejects.toThrow(
      `You can save up to ${YOUTUBE_QUEUE_LIBRARY_MAX_QUEUES} queues.`,
    );
    expect(backing.read()).toBe(before);
  });
});
