import type { FileDiffMetadata } from "@pierre/diffs/react";

export const FILE_DIFF_MAX_RICH_CHANGED_CHARS = 240_000;
export const FILE_DIFF_MAX_RICH_LINE_CHARS = 20_000;
export const FILE_DIFF_MAX_RICH_VISUAL_LINES = 8_000;

export interface FileDiffRenderCost {
  readonly changedLineCount: number;
  readonly visualLineCount: number;
  readonly totalChangedChars: number;
  readonly maxChangedLineChars: number;
}

export interface FileDiffRenderGuard extends FileDiffRenderCost {
  readonly shouldRenderRichDiff: boolean;
  readonly reason: string | null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function readOptionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function readLineArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function readLineText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  const record = readRecord(value);
  if (!record) {
    return "";
  }

  for (const key of ["content", "text", "value", "line"]) {
    const candidate = record[key];
    if (typeof candidate === "string") {
      return candidate;
    }
  }

  return "";
}

function summarizeChangedLines(lines: readonly unknown[]): {
  readonly totalChars: number;
  readonly maxLineChars: number;
} {
  let totalChars = 0;
  let maxLineChars = 0;

  for (const line of lines) {
    const length = readLineText(line).length;
    totalChars += length;
    maxLineChars = Math.max(maxLineChars, length);
  }

  return { totalChars, maxLineChars };
}

export function resolveFileDiffRenderGuard(fileDiff: FileDiffMetadata): FileDiffRenderGuard {
  const record = fileDiff as unknown as Record<string, unknown>;
  const additionLines = readLineArray(record.additionLines);
  const deletionLines = readLineArray(record.deletionLines);
  const changedLineCount = additionLines.length + deletionLines.length;
  const additionStats = summarizeChangedLines(additionLines);
  const deletionStats = summarizeChangedLines(deletionLines);
  const totalChangedChars = additionStats.totalChars + deletionStats.totalChars;
  const maxChangedLineChars = Math.max(additionStats.maxLineChars, deletionStats.maxLineChars);
  const visualLineCount =
    readOptionalNumber(record.unifiedLineCount) ??
    readOptionalNumber(record.splitLineCount) ??
    changedLineCount;

  // The rich diff renderer virtualizes rows, but a small number of enormous
  // changed lines still become large DOM text nodes and can lock the renderer.
  if (maxChangedLineChars > FILE_DIFF_MAX_RICH_LINE_CHARS) {
    return {
      changedLineCount,
      maxChangedLineChars,
      reason: "This file has an extremely long changed line.",
      shouldRenderRichDiff: false,
      totalChangedChars,
      visualLineCount,
    };
  }

  if (totalChangedChars > FILE_DIFF_MAX_RICH_CHANGED_CHARS) {
    return {
      changedLineCount,
      maxChangedLineChars,
      reason: "This file has a very large changed-text payload.",
      shouldRenderRichDiff: false,
      totalChangedChars,
      visualLineCount,
    };
  }

  if (visualLineCount > FILE_DIFF_MAX_RICH_VISUAL_LINES) {
    return {
      changedLineCount,
      maxChangedLineChars,
      reason: "This file has too many diff lines for rich rendering.",
      shouldRenderRichDiff: false,
      totalChangedChars,
      visualLineCount,
    };
  }

  return {
    changedLineCount,
    maxChangedLineChars,
    reason: null,
    shouldRenderRichDiff: true,
    totalChangedChars,
    visualLineCount,
  };
}

export function formatDiffMetric(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  return String(value);
}
