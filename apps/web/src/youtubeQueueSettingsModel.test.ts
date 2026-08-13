import { describe, expect, it } from "vitest";

import {
  isYouTubeQueueTextFileName,
  previewYouTubeQueueImport,
  suggestedYouTubeQueueName,
  YOUTUBE_QUEUE_VISIBLE_ISSUE_LIMIT,
} from "./youtubeQueueSettingsModel";

function canonicalUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

describe("YouTube queue settings model", () => {
  it("returns an immutable IDs-only preview with bounded diagnostics", () => {
    const rawUrl = canonicalUrl("AAAAAAAAAAA");
    const malformed = Array.from(
      { length: YOUTUBE_QUEUE_VISIBLE_ISSUE_LIMIT + 3 },
      (_, index) => `invalid-${index}`,
    );

    const result = previewYouTubeQueueImport([rawUrl, rawUrl, ...malformed].join("\n"));

    expect(result).toMatchObject({
      ok: true,
      videoIds: ["AAAAAAAAAAA"],
      counts: {
        accepted: 1,
        duplicate: 1,
        malformed: YOUTUBE_QUEUE_VISIBLE_ISSUE_LIMIT + 3,
      },
      hiddenIssueCount: 3,
    });
    if (!result.ok) throw new Error("Expected a valid preview");
    expect(result.visibleIssues).toHaveLength(YOUTUBE_QUEUE_VISIBLE_ISSUE_LIMIT);
    expect(JSON.stringify(result)).not.toContain(rawUrl);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.videoIds)).toBe(true);
    expect(Object.isFrozen(result.counts)).toBe(true);
    expect(Object.isFrozen(result.visibleIssues)).toBe(true);
  });

  it("reports bounded diagnostics for an empty accepted queue without retaining input text", () => {
    const result = previewYouTubeQueueImport("https://example.com/private-value");

    expect(result).toMatchObject({
      ok: true,
      videoIds: [],
      counts: { accepted: 0, malformed: 1 },
      visibleIssues: [{ line: 1, reason: "invalid-url" }],
    });
    expect(JSON.stringify(result)).not.toContain("private-value");
  });

  it("derives a replacement-friendly queue name from a text filename", () => {
    expect(suggestedYouTubeQueueName("EDMYoutubeList.txt")).toBe("EDMYoutubeList");
    expect(suggestedYouTubeQueueName("  Ｍｉｘ\u0000\t 音楽.TXT ")).toBe("Mix 音楽");
    expect(suggestedYouTubeQueueName("🎵".repeat(100))).toBe("🎵".repeat(64));
    expect(suggestedYouTubeQueueName("  .txt ")).toBe("Imported queue");
  });

  it("accepts only normalized text-file names", () => {
    expect(isYouTubeQueueTextFileName("Queue.TXT ")).toBe(true);
    expect(isYouTubeQueueTextFileName("Ｑｕｅｕｅ．ｔｘｔ")).toBe(true);
    expect(isYouTubeQueueTextFileName("Queue.csv")).toBe(false);
  });
});
