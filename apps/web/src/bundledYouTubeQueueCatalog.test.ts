import { describe, expect, it } from "vitest";
import * as bundledQueueModule from "./bundledYouTubeQueueCatalog";
import {
  BUNDLED_YOUTUBE_QUEUE_CATALOG,
  DEFAULT_BUNDLED_YOUTUBE_QUEUE_ID,
  loadBundledYouTubeQueue,
} from "./bundledYouTubeQueueCatalog";

describe("bundled YouTube queue catalog", () => {
  it("publishes all reviewed queues in stable display order", () => {
    expect(Object.keys(bundledQueueModule).toSorted()).toEqual([
      "BUNDLED_YOUTUBE_QUEUE_CATALOG",
      "DEFAULT_BUNDLED_YOUTUBE_QUEUE_ID",
      "loadBundledYouTubeQueue",
    ]);
    expect(DEFAULT_BUNDLED_YOUTUBE_QUEUE_ID).toBe("japanese");
    expect(BUNDLED_YOUTUBE_QUEUE_CATALOG).toEqual([
      { id: "japanese", label: "Japanese music", itemCount: 71 },
      { id: "edm", label: "EDM", itemCount: 30 },
      { id: "kpop", label: "K-pop", itemCount: 8 },
    ]);
    expect(Object.isFrozen(BUNDLED_YOUTUBE_QUEUE_CATALOG)).toBe(true);
    expect(BUNDLED_YOUTUBE_QUEUE_CATALOG.every(Object.isFrozen)).toBe(true);
    expect(
      BUNDLED_YOUTUBE_QUEUE_CATALOG.every(
        (entry) => Reflect.ownKeys(entry).map(String).toSorted().join(",") === "id,itemCount,label",
      ),
    ).toBe(true);
  });

  it.each([
    [
      "japanese",
      {
        totalLines: 78,
        blank: 0,
        comment: 1,
        accepted: 71,
        duplicate: 3,
        malformed: 3,
        overflow: 0,
      },
    ],
    [
      "edm",
      {
        totalLines: 32,
        blank: 0,
        comment: 1,
        accepted: 30,
        duplicate: 0,
        malformed: 1,
        overflow: 0,
      },
    ],
    [
      "kpop",
      {
        totalLines: 9,
        blank: 0,
        comment: 1,
        accepted: 8,
        duplicate: 0,
        malformed: 0,
        overflow: 0,
      },
    ],
  ] as const)("loads the reviewed %s queue", (id, expectedCounts) => {
    const result = loadBundledYouTubeQueue(id);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Reviewed bundled queue must load.");
    expect(result.entry.queue.counts).toEqual(expectedCounts);
    expect(result.entry.queue.videoIds).toHaveLength(expectedCounts.accepted);
    expect(BUNDLED_YOUTUBE_QUEUE_CATALOG.find((entry) => entry.id === id)?.itemCount).toBe(
      expectedCounts.accepted,
    );
    expect(expectedCounts.totalLines).toBe(
      expectedCounts.blank +
        expectedCounts.comment +
        expectedCounts.accepted +
        expectedCounts.duplicate +
        expectedCounts.malformed +
        expectedCounts.overflow,
    );
    expect(result.entry.queue.issues).toHaveLength(expectedCounts.malformed);
    expect(result.entry.queue.issuesTruncated).toBe(false);
    expect(JSON.stringify(result)).not.toContain("youtube.com");
    expect(JSON.stringify(result)).not.toContain("youtu.be");
    expect(Reflect.ownKeys(result).map(String).toSorted()).toEqual(["entry", "ok"]);
    expect(Reflect.ownKeys(result.entry).map(String).toSorted()).toEqual(["id", "label", "queue"]);
    expect(Reflect.ownKeys(result.entry.queue).map(String).toSorted()).toEqual([
      "counts",
      "issues",
      "issuesTruncated",
      "videoIds",
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.entry)).toBe(true);
    expect(Object.isFrozen(result.entry.queue)).toBe(true);
    expect(Object.isFrozen(result.entry.queue.videoIds)).toBe(true);
    expect(Object.isFrozen(result.entry.queue.counts)).toBe(true);
    expect(Object.isFrozen(result.entry.queue.issues)).toBe(true);
    expect(result.entry.queue.issues.every(Object.isFrozen)).toBe(true);
  });

  it("fails closed for an unknown id without echoing it", () => {
    const result = loadBundledYouTubeQueue("private-operator-value");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Unknown bundled queues must fail closed.");
    expect(result).toEqual({
      ok: false,
      error: { reason: "unknown-bundled-queue" },
    });
    expect(JSON.stringify(result)).not.toContain("private-operator-value");
    expect(Reflect.ownKeys(result).map(String).toSorted()).toEqual(["error", "ok"]);
    expect(Reflect.ownKeys(result.error)).toEqual(["reason"]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.error)).toBe(true);
  });

  it("returns a fresh immutable queue for each explicit load", () => {
    const first = loadBundledYouTubeQueue("edm");
    const second = loadBundledYouTubeQueue("edm");

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("Reviewed bundled queue must load.");
    expect(first.entry).not.toBe(second.entry);
    expect(first.entry.queue.videoIds).not.toBe(second.entry.queue.videoIds);
    expect(first.entry.queue.videoIds).toEqual(second.entry.queue.videoIds);
    expect(Reflect.set(first.entry, "label", "Changed externally")).toBe(false);
    expect(Reflect.set(first.entry.queue.videoIds, "0", "private-id")).toBe(false);
    expect(second.entry.label).toBe("EDM");
    expect(second.entry.queue.videoIds[0]).not.toBe("private-id");
  });
});
