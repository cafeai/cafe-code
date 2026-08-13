import {
  parseYouTubeUrlQueue,
  type YouTubeQueueLineIssue,
  type YouTubeQueueParseCounts,
  type YouTubeQueueParseErrorReason,
} from "./youtubeQueueParser";
import {
  YOUTUBE_QUEUE_LIBRARY_MAX_NAME_BYTES,
  YOUTUBE_QUEUE_LIBRARY_MAX_NAME_CODE_POINTS,
} from "./youtubeQueueLibrary";

export const YOUTUBE_QUEUE_VISIBLE_ISSUE_LIMIT = 8;

const DEFAULT_IMPORTED_QUEUE_NAME = "Imported queue";
const UNSAFE_FILE_NAME_CHARACTER_PATTERN = /[\p{Cc}\p{Cf}\p{Cs}]/gu;

export interface YouTubeQueueImportPreview {
  readonly ok: true;
  readonly videoIds: readonly string[];
  readonly counts: YouTubeQueueParseCounts;
  readonly visibleIssues: readonly YouTubeQueueLineIssue[];
  readonly hiddenIssueCount: number;
}

export interface YouTubeQueueImportPreviewError {
  readonly ok: false;
  readonly message: string;
}

export type YouTubeQueueImportPreviewResult =
  | YouTubeQueueImportPreview
  | YouTubeQueueImportPreviewError;

function parseErrorMessage(reason: YouTubeQueueParseErrorReason): string {
  switch (reason) {
    case "input-too-many-bytes":
      return "The queue text is too large. Reduce it to 256 KB or less.";
    case "input-too-many-lines":
      return "The queue text has too many lines. Use no more than 1,000 lines.";
  }
}

/**
 * Converts raw queue text into an IDs-only import payload and bounded display
 * diagnostics. The returned object never retains the raw URL text.
 */
export function previewYouTubeQueueImport(text: string): YouTubeQueueImportPreviewResult {
  const parsed = parseYouTubeUrlQueue(text);
  if (!parsed.ok) {
    return Object.freeze({ ok: false, message: parseErrorMessage(parsed.error.reason) });
  }
  const visibleIssues = parsed.queue.issues.slice(0, YOUTUBE_QUEUE_VISIBLE_ISSUE_LIMIT);
  return Object.freeze({
    ok: true,
    videoIds: Object.freeze([...parsed.queue.videoIds]),
    counts: Object.freeze({ ...parsed.queue.counts }),
    visibleIssues: Object.freeze(
      visibleIssues.map((issue) => Object.freeze({ line: issue.line, reason: issue.reason })),
    ),
    hiddenIssueCount: Math.max(0, parsed.queue.counts.malformed - visibleIssues.length),
  });
}

export function suggestedYouTubeQueueName(fileName: string): string {
  const normalized = fileName
    .normalize("NFKC")
    .trim()
    .replace(/\.txt$/iu, "")
    .replace(UNSAFE_FILE_NAME_CHARACTER_PATTERN, " ")
    .trim()
    .replace(/\s+/gu, " ");

  const characters: string[] = [];
  let byteLength = 0;
  for (const character of normalized) {
    const characterBytes = new TextEncoder().encode(character).byteLength;
    if (
      characters.length >= YOUTUBE_QUEUE_LIBRARY_MAX_NAME_CODE_POINTS ||
      byteLength + characterBytes > YOUTUBE_QUEUE_LIBRARY_MAX_NAME_BYTES
    ) {
      break;
    }
    characters.push(character);
    byteLength += characterBytes;
  }

  return characters.join("").trim() || DEFAULT_IMPORTED_QUEUE_NAME;
}

export function isYouTubeQueueTextFileName(fileName: string): boolean {
  return /\.txt$/iu.test(fileName.normalize("NFKC").trim());
}
