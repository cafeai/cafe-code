import { describe, expect, it } from "vitest";
import type { FileDiffMetadata } from "@pierre/diffs/react";

import {
  FILE_DIFF_MAX_RICH_CHANGED_CHARS,
  FILE_DIFF_MAX_RICH_LINE_CHARS,
  FILE_DIFF_MAX_RICH_VISUAL_LINES,
  formatDiffMetric,
  resolveFileDiffRenderGuard,
} from "./DiffPanel.logic";

function makeFileDiff(overrides: Partial<FileDiffMetadata> = {}): FileDiffMetadata {
  return {
    additionLines: [],
    cacheKey: "diff-cache-key",
    deletionLines: [],
    hunks: [],
    isPartial: false,
    mode: "100644",
    name: "file.txt",
    newObjectId: "new",
    prevName: undefined,
    prevObjectId: "old",
    splitLineCount: 2,
    type: "change",
    unifiedLineCount: 2,
    ...overrides,
  } as FileDiffMetadata;
}

describe("resolveFileDiffRenderGuard", () => {
  it("allows ordinary file diffs to use rich rendering", () => {
    const guard = resolveFileDiffRenderGuard(
      makeFileDiff({
        additionLines: ["hello"],
        deletionLines: ["goodbye"],
      }),
    );

    expect(guard.shouldRenderRichDiff).toBe(true);
    expect(guard.reason).toBeNull();
  });

  it("blocks a file diff with one extremely long changed line", () => {
    const guard = resolveFileDiffRenderGuard(
      makeFileDiff({
        additionLines: ["x".repeat(FILE_DIFF_MAX_RICH_LINE_CHARS + 1)],
      }),
    );

    expect(guard.shouldRenderRichDiff).toBe(false);
    expect(guard.reason).toContain("extremely long");
  });

  it("blocks a file diff with a very large changed-text payload", () => {
    const guard = resolveFileDiffRenderGuard(
      makeFileDiff({
        additionLines: Array.from({ length: 30 }, () =>
          "x".repeat(Math.ceil(FILE_DIFF_MAX_RICH_CHANGED_CHARS / 30) + 1),
        ),
      }),
    );

    expect(guard.shouldRenderRichDiff).toBe(false);
    expect(guard.reason).toContain("large changed-text");
  });

  it("blocks a file diff with too many visual lines", () => {
    const guard = resolveFileDiffRenderGuard(
      makeFileDiff({
        unifiedLineCount: FILE_DIFF_MAX_RICH_VISUAL_LINES + 1,
      }),
    );

    expect(guard.shouldRenderRichDiff).toBe(false);
    expect(guard.reason).toContain("too many");
  });
});

describe("formatDiffMetric", () => {
  it("formats compact metric values", () => {
    expect(formatDiffMetric(42)).toBe("42");
    expect(formatDiffMetric(12_345)).toBe("12.3k");
    expect(formatDiffMetric(1_234_567)).toBe("1.2M");
  });
});
