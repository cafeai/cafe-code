import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@cafecode/contracts";
import { describe, expect, it, vi } from "vitest";

import { createMemoryStorage, type StateStorage } from "../../lib/storage";
import {
  createFollowUpQueuePersistence,
  FOLLOW_UP_QUEUE_STORAGE_KEY,
  MAX_PERSISTED_FOLLOW_UP_QUEUE_BYTES,
  type FollowUpQueueClaim,
  type FollowUpQueuePersistenceItem,
} from "./followUpQueuePersistence";

const environmentA = EnvironmentId.make("environment-a");
const environmentB = EnvironmentId.make("environment-b");
const threadId = ThreadId.make("thread-1");

function item(id = "queued-item-1", environmentId = environmentA): FollowUpQueuePersistenceItem {
  return {
    id,
    environmentId,
    threadId,
    promptText: "Review these files",
    images: [],
    files: [
      {
        type: "file",
        id: "uploaded-file",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 123,
      },
    ],
    provider: ProviderDriverKind.make("codex"),
    model: "gpt-5.4-mini",
    promptEffort: "low",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4-mini" },
    runtimeMode: "full-access",
    interactionMode: "default",
    queuedAt: "2026-09-05T00:00:00.000Z",
    blockedReason: null,
  };
}

function claim(value: FollowUpQueuePersistenceItem): FollowUpQueueClaim {
  return {
    environmentId: value.environmentId,
    threadId: value.threadId,
    itemId: value.id,
    // Production queue rows use one stable UUID as both identities. Separate
    // prefixes here make accidental command/message swaps visible in tests.
    commandId: CommandId.make(`command-${value.id}`),
    messageId: MessageId.make(`message-${value.id}`),
  };
}

function image(file = new File([new Uint8Array([1, 2, 3])], "pixel.png", { type: "image/png" })) {
  return {
    type: "image" as const,
    id: "image-1",
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    previewUrl: "blob:only-this-renderer",
    file,
  };
}

function raw(storage: StateStorage): string {
  const value = storage.getItem(FOLLOW_UP_QUEUE_STORAGE_KEY);
  if (typeof value !== "string") throw new Error("Missing fixture storage");
  return value;
}

describe("follow-up queue persistence", () => {
  it("round-trips pending metadata and bounded image data without paths, blobs, or file bodies", async () => {
    const storage = createMemoryStorage();
    const persistence = createFollowUpQueuePersistence(storage);
    const original = {
      ...item(),
      images: [image()],
      providerModels: [{ internalMetadata: "not persisted" }],
      files: [
        {
          ...item().files![0]!,
          privatePath: "/private/user-file.pdf",
          file: new File(["secret bytes"], "local.pdf"),
        },
      ],
    };
    expect(await persistence.save(environmentA, [original])).toEqual({
      ok: true,
      value: undefined,
    });
    const serialized = raw(storage);
    expect(serialized).not.toContain("blob:");
    expect(serialized).not.toContain("/private/");
    expect(serialized).not.toContain("secret bytes");
    expect(serialized).not.toContain("internalMetadata");
    expect(serialized).toContain("data:image/png;base64,AQID");
    const loaded = persistence.load(environmentA);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.claimed).toEqual([]);
    expect(loaded.value.pending[0]).toMatchObject({
      id: original.id,
      environmentId: environmentA,
      threadId,
      promptText: original.promptText,
      files: item().files,
      providerModels: [],
      dispatchState: "pending",
      expanded: false,
    });
    expect(new Uint8Array(await loaded.value.pending[0]!.images[0]!.file.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("keeps identical thread/item ids isolated between environments", async () => {
    const storage = createMemoryStorage();
    const persistence = createFollowUpQueuePersistence(storage);
    await persistence.save(environmentA, [item()]);
    await persistence.save(environmentB, [
      { ...item("queued-item-1", environmentB), promptText: "Other environment" },
    ]);
    expect(persistence.claim(claim(item()), item()).ok).toBe(true);
    expect(await persistence.save(environmentA, [])).toEqual({ ok: true, value: undefined });
    const loadedA = persistence.load(environmentA);
    const loadedB = persistence.load(environmentB);
    expect(loadedA.ok && loadedA.value.pending).toEqual([]);
    expect(loadedA.ok && loadedA.value.claimed).toHaveLength(1);
    expect(loadedB.ok && loadedB.value.pending[0]?.promptText).toBe("Other environment");
    expect(await persistence.save(environmentA, [item("foreign", environmentB)])).toMatchObject({
      ok: false,
    });
    expect(persistence.load(environmentB)).toEqual(loadedB);
  });

  it("claims synchronously before dispatch and never hydrates a claim as auto-sendable", async () => {
    const storage = createMemoryStorage();
    const persistence = createFollowUpQueuePersistence(storage);
    const original = item();
    await persistence.save(environmentA, [original]);
    expect(persistence.claim(claim(original), original)).toEqual({ ok: true, value: undefined });
    const restored = createFollowUpQueuePersistence(storage).load(environmentA);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.value.pending).toEqual([]);
    expect(restored.value.claimed[0]).toMatchObject({
      dispatchState: "claimed",
      blockedReason: expect.stringContaining("unknown after reload"),
      claimedDispatch: {
        commandId: claim(original).commandId,
        messageId: claim(original).messageId,
      },
    });
    expect(persistence.claim(claim(original), original)).toMatchObject({ ok: false });
    expect(
      persistence.settleClaim({ ...claim(original), commandId: CommandId.make("wrong-command") }),
    ).toMatchObject({ ok: false });
    expect(persistence.settleClaim(claim(original))).toEqual({ ok: true, value: undefined });
    expect(persistence.load(environmentA)).toEqual({
      ok: true,
      value: { pending: [], claimed: [] },
    });
  });

  it("prevents a delayed image save from resurrecting an already claimed or settled row", async () => {
    const storage = createMemoryStorage();
    const persistence = createFollowUpQueuePersistence(storage);
    const original = item();
    await persistence.save(environmentA, [original]);
    let finishRead!: (bytes: ArrayBuffer) => void;
    const pendingRead = new Promise<ArrayBuffer>((resolve) => {
      finishRead = resolve;
    });
    const delayedFile = new File([new Uint8Array([1, 2, 3])], "pixel.png", { type: "image/png" });
    Object.defineProperty(delayedFile, "arrayBuffer", { value: () => pendingRead });
    const saving = persistence.save(environmentA, [{ ...original, images: [image(delayedFile)] }]);
    expect(persistence.claim(claim(original), original).ok).toBe(true);
    expect(persistence.settleClaim(claim(original)).ok).toBe(true);
    finishRead(new Uint8Array([1, 2, 3]).buffer);
    expect(await saving).toMatchObject({ ok: false });
    expect(persistence.load(environmentA)).toEqual({
      ok: true,
      value: { pending: [], claimed: [] },
    });
  });

  it("preserves another writer's claimed marker when saving stale pending state", async () => {
    const storage = createMemoryStorage();
    const first = createFollowUpQueuePersistence(storage);
    const second = createFollowUpQueuePersistence(storage);
    await first.save(environmentA, [item()]);
    expect(second.claim(claim(item()), item()).ok).toBe(true);
    expect(await first.save(environmentA, [item()])).toMatchObject({ ok: true });
    const loaded = first.load(environmentA);
    expect(loaded.ok && loaded.value.pending).toEqual([]);
    expect(loaded.ok && loaded.value.claimed).toHaveLength(1);
  });

  it("upserts exact new rows without erasing another mounted view's pending queue", async () => {
    const storage = createMemoryStorage();
    const first = createFollowUpQueuePersistence(storage);
    const second = createFollowUpQueuePersistence(storage);
    const firstRow = item("first-view");
    const secondRow = { ...item("second-view"), threadId: ThreadId.make("other-thread") };
    expect((await first.save(environmentA, [firstRow])).ok).toBe(true);
    expect((await second.save(environmentA, [secondRow])).ok).toBe(true);
    expect((await first.save(environmentA, [firstRow])).ok).toBe(true);
    const loaded = first.load(environmentA);
    expect(loaded.ok && loaded.value.pending.map((row) => row.id)).toEqual([
      firstRow.id,
      secondRow.id,
    ]);
    expect(
      await first.save(environmentA, [{ ...firstRow, promptText: "stale implicit overwrite" }]),
    ).toMatchObject({ ok: false });
    expect(first.load(environmentA)).toEqual(loaded);
    expect((await first.save(environmentA, [])).ok).toBe(true);
    expect(first.load(environmentA)).toEqual(loaded);
  });

  it("compares exact saved intent before an edit or dispatch can replace a newer instruction", async () => {
    const storage = createMemoryStorage();
    const first = createFollowUpQueuePersistence(storage);
    const second = createFollowUpQueuePersistence(storage);
    const original = item();
    const edited = { ...original, promptText: "newer instruction", model: "gpt-5.5" };
    expect((await first.save(environmentA, [original])).ok).toBe(true);
    expect((await second.replacePending(original, edited)).ok).toBe(true);
    expect(
      await first.replacePending(original, { ...original, promptText: "stale edit" }),
    ).toMatchObject({ ok: false });
    expect(first.claim(claim(original), original)).toMatchObject({ ok: false });
    expect(first.claim(claim(edited), { ...edited, files: [] })).toMatchObject({ ok: false });
    expect(
      first.claim(claim(edited), { ...edited, runtimeMode: "approval-required" }),
    ).toMatchObject({ ok: false });
    expect(first.claim(claim(edited), edited)).toEqual({ ok: true, value: undefined });
    expect(await second.replacePending(edited, original)).toMatchObject({ ok: false });
  });

  it("binds image bytes, not only ids and sizes, and keeps that binding across hydration factories", async () => {
    const storage = createMemoryStorage();
    const first = createFollowUpQueuePersistence(storage);
    const original = { ...item(), images: [image()] };
    expect((await first.save(environmentA, [original])).ok).toBe(true);
    const changed = {
      ...original,
      images: [image(new File([new Uint8Array([9, 9, 9])], "pixel.png", { type: "image/png" }))],
    };
    expect(first.claim(claim(original), changed)).toMatchObject({ ok: false });
    // Even after an attempted save has encoded the different immutable File,
    // identical metadata must not make those bytes equal to the saved upload.
    expect(await first.save(environmentA, [changed])).toMatchObject({ ok: false });
    expect(first.claim(claim(original), changed)).toMatchObject({ ok: false });
    const loaded = createFollowUpQueuePersistence(storage).load(environmentA);
    if (!loaded.ok) throw new Error("Missing saved image fixture");
    expect(first.claim(claim(original), loaded.value.pending[0]!)).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it("does not resurrect a removed row when another view finishes encoding an edit", async () => {
    const storage = createMemoryStorage();
    const first = createFollowUpQueuePersistence(storage);
    const second = createFollowUpQueuePersistence(storage);
    const original = item();
    await first.save(environmentA, [original]);
    let finishRead!: (value: ArrayBuffer) => void;
    const file = new File([new Uint8Array([1, 2, 3])], "pixel.png", { type: "image/png" });
    Object.defineProperty(file, "arrayBuffer", {
      value: () =>
        new Promise<ArrayBuffer>((resolve) => {
          finishRead = resolve;
        }),
    });
    const editing = first.replacePending(original, { ...original, images: [image(file)] });
    expect(second.removePending(claim(original)).ok).toBe(true);
    finishRead(new Uint8Array([1, 2, 3]).buffer);
    expect(await editing).toMatchObject({ ok: false });
    expect(first.claim(claim(original), original)).toMatchObject({ ok: false });
    expect(first.load(environmentA)).toEqual({ ok: true, value: { pending: [], claimed: [] } });
  });

  it("removes an exact unsent row synchronously without clearing a claim or another environment", async () => {
    const storage = createMemoryStorage();
    const persistence = createFollowUpQueuePersistence(storage);
    await persistence.save(environmentA, [item()]);
    await persistence.save(environmentB, [item("queued-item-1", environmentB)]);
    expect(persistence.removePending(claim(item())).ok).toBe(true);
    expect(createFollowUpQueuePersistence(storage).load(environmentA)).toEqual({
      ok: true,
      value: { pending: [], claimed: [] },
    });
    const otherClaim = claim(item("queued-item-1", environmentB));
    expect(persistence.claim(otherClaim, item("queued-item-1", environmentB)).ok).toBe(true);
    expect(persistence.removePending(otherClaim)).toMatchObject({ ok: false });
    const otherLoaded = persistence.load(environmentB);
    expect(otherLoaded.ok && otherLoaded.value.claimed).toHaveLength(1);
  });

  it("leaves existing data untouched on quota failures and fails closed when claiming", async () => {
    const base = createMemoryStorage();
    await createFollowUpQueuePersistence(base).save(environmentA, [item()]);
    const before = raw(base);
    const storage: StateStorage = {
      ...base,
      setItem: () => {
        throw new Error("sensitive quota diagnostic");
      },
    };
    const persistence = createFollowUpQueuePersistence(storage);
    const saved = await persistence.replacePending(item(), {
      ...item(),
      promptText: "new unsaved edit",
    });
    expect(saved).toMatchObject({ ok: false, error: expect.stringContaining("storage") });
    expect(JSON.stringify(saved)).not.toContain("sensitive");
    expect(persistence.claim(claim(item()), item())).toMatchObject({ ok: false });
    expect(raw(base)).toBe(before);
  });

  it("rejects missing, silently dropped, or asynchronous claim writes", async () => {
    const base = createMemoryStorage();
    const persistence = createFollowUpQueuePersistence(base);
    expect(persistence.claim(claim(item()), item())).toMatchObject({ ok: false });
    await persistence.save(environmentA, [item()]);
    const dropped = createFollowUpQueuePersistence({ ...base, setItem: () => undefined });
    expect(dropped.claim(claim(item()), item())).toMatchObject({ ok: false });
    const asynchronous = createFollowUpQueuePersistence({
      ...base,
      setItem: () => Promise.resolve(),
    });
    expect(asynchronous.claim(claim(item()), item())).toMatchObject({ ok: false });
  });

  it("rejects duplicate rows, excess rows, and excess attachments without truncation", async () => {
    const storage = createMemoryStorage();
    const persistence = createFollowUpQueuePersistence(storage);
    await persistence.save(environmentA, [item()]);
    const before = raw(storage);
    expect(await persistence.save(environmentA, [item(), item()])).toMatchObject({ ok: false });
    expect(
      await persistence.save(
        environmentA,
        Array.from({ length: 65 }, (_, index) => item(`row-${index}`)),
      ),
    ).toMatchObject({ ok: false });
    expect(
      await persistence.save(environmentA, [
        { ...item(), files: Array.from({ length: 9 }, () => item().files![0]!) },
      ]),
    ).toMatchObject({ ok: false });
    expect(raw(storage)).toBe(before);
  });

  it("rejects aggregate image budgets before allocating or encoding file contents", async () => {
    const storage = createMemoryStorage();
    const persistence = createFollowUpQueuePersistence(storage);
    const oversizedFile = new File([], "large.png", { type: "image/png" });
    Object.defineProperty(oversizedFile, "size", { value: 10 * 1024 * 1024 });
    const read = vi.fn(() => Promise.reject(new Error("must not read fixture bytes")));
    Object.defineProperty(oversizedFile, "arrayBuffer", { value: read });
    const largeImage = image(oversizedFile);
    // Each row remains within the image/attachment bounds, but base64 encoding
    // seven maximum-sized images would exceed the entire queue's 80 MiB cap.
    expect(
      await persistence.save(
        environmentA,
        Array.from({ length: 7 }, (_, index) => ({
          ...item(`large-row-${index}`),
          images: [{ ...largeImage, id: `image-${index}` }],
          files: [],
        })),
      ),
    ).toMatchObject({ ok: false });
    expect(read).not.toHaveBeenCalled();
    expect(storage.getItem(FOLLOW_UP_QUEUE_STORAGE_KEY)).toBeNull();
  });

  it("rejects malformed, oversized, active-format, and inconsistent persisted image data", async () => {
    const storage = createMemoryStorage();
    const persistence = createFollowUpQueuePersistence(storage);
    await persistence.save(environmentA, [{ ...item(), images: [image()] }]);
    const valid = raw(storage);
    type TamperedQueue = {
      version: number;
      items: Array<{ images: Array<{ sizeBytes: number; dataUrl: string; mimeType: string }> }>;
    };
    for (const mutate of [
      (value: TamperedQueue) => {
        value.items[0]!.images[0]!.sizeBytes = 2;
      },
      (value: TamperedQueue) => {
        value.items[0]!.images[0]!.dataUrl = "https://outside.example/image.png";
      },
      (value: TamperedQueue) => {
        value.items[0]!.images[0]!.mimeType = "image/svg+xml";
        value.items[0]!.images[0]!.dataUrl = "data:image/svg+xml;base64,AQID";
      },
      (value: TamperedQueue) => {
        value.items[0]!.images[0]!.dataUrl = "data:image/png;base64,AQ-D";
      },
      (value: TamperedQueue) => {
        value.version = 2;
      },
    ]) {
      const altered = JSON.parse(valid);
      mutate(altered);
      storage.setItem(FOLLOW_UP_QUEUE_STORAGE_KEY, JSON.stringify(altered));
      expect(persistence.load(environmentA)).toMatchObject({ ok: false });
    }
    storage.setItem(
      FOLLOW_UP_QUEUE_STORAGE_KEY,
      "x".repeat(MAX_PERSISTED_FOLLOW_UP_QUEUE_BYTES + 1),
    );
    expect(persistence.load(environmentA)).toMatchObject({ ok: false });
  });

  it("does not persist automatic steer retries already owned by durable provider evidence", async () => {
    const storage = createMemoryStorage();
    const persistence = createFollowUpQueuePersistence(storage);
    expect(
      await persistence.save(environmentA, [
        { ...item(), automaticSteerRetry: { sourceMessageId: "provider-owned" } },
      ]),
    ).toMatchObject({ ok: true });
    expect(persistence.load(environmentA)).toEqual({
      ok: true,
      value: { pending: [], claimed: [] },
    });
  });
});
