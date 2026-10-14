import edmQueueText from "../../../examples/youtube-url-queues/EDMYoutubeList.txt?raw";
import japaneseQueueText from "../../../examples/youtube-url-queues/JPMusic.txt?raw";
import kpopQueueText from "../../../examples/youtube-url-queues/KPOPList.txt?raw";
import {
  parseYouTubeUrlQueue,
  type ParsedYouTubeUrlQueue,
  type YouTubeQueueLineIssue,
  type YouTubeQueueParseCounts,
} from "./youtubeQueueParser";

export type BundledYouTubeQueueId = "japanese" | "edm" | "kpop";

export interface BundledYouTubeQueueCatalogEntry {
  readonly id: BundledYouTubeQueueId;
  readonly label: string;
  readonly itemCount: number;
}

export interface LoadedBundledYouTubeQueue {
  readonly id: BundledYouTubeQueueId;
  readonly label: string;
  readonly queue: ParsedYouTubeUrlQueue;
}

export type BundledYouTubeQueueLoadResult =
  | { readonly ok: true; readonly entry: LoadedBundledYouTubeQueue }
  | {
      readonly ok: false;
      readonly error: { readonly reason: "unknown-bundled-queue" | "invalid-bundled-queue" };
    };

interface BundledYouTubeQueueSource extends BundledYouTubeQueueCatalogEntry {
  readonly text: string;
  readonly expectedCounts: YouTubeQueueParseCounts;
}

export const DEFAULT_BUNDLED_YOUTUBE_QUEUE_ID: BundledYouTubeQueueId = "japanese";

const SOURCES: readonly BundledYouTubeQueueSource[] = Object.freeze(
  (
    [
      {
        id: "japanese",
        label: "Japanese music",
        itemCount: 71,
        text: japaneseQueueText,
        expectedCounts: {
          totalLines: 78,
          blank: 0,
          comment: 1,
          accepted: 71,
          duplicate: 3,
          malformed: 3,
          overflow: 0,
        },
      },
      {
        id: "edm",
        label: "EDM",
        itemCount: 30,
        text: edmQueueText,
        expectedCounts: {
          totalLines: 32,
          blank: 0,
          comment: 1,
          accepted: 30,
          duplicate: 0,
          malformed: 1,
          overflow: 0,
        },
      },
      {
        id: "kpop",
        label: "K-pop",
        itemCount: 8,
        text: kpopQueueText,
        expectedCounts: {
          totalLines: 9,
          blank: 0,
          comment: 1,
          accepted: 8,
          duplicate: 0,
          malformed: 0,
          overflow: 0,
        },
      },
    ] satisfies readonly BundledYouTubeQueueSource[]
  ).map((source) =>
    Object.freeze({
      ...source,
      expectedCounts: freezeCounts(source.expectedCounts),
    }),
  ),
);

export const BUNDLED_YOUTUBE_QUEUE_CATALOG: readonly BundledYouTubeQueueCatalogEntry[] =
  Object.freeze(SOURCES.map(({ id, label, itemCount }) => Object.freeze({ id, label, itemCount })));

function countsMatch(actual: YouTubeQueueParseCounts, expected: YouTubeQueueParseCounts): boolean {
  return (Object.keys(expected) as (keyof YouTubeQueueParseCounts)[]).every(
    (key) => actual[key] === expected[key],
  );
}

function freezeCounts(counts: YouTubeQueueParseCounts): YouTubeQueueParseCounts {
  return Object.freeze({ ...counts });
}

function freezeIssues(issues: readonly YouTubeQueueLineIssue[]): readonly YouTubeQueueLineIssue[] {
  return Object.freeze(issues.map((issue) => Object.freeze({ ...issue })));
}

function freezeQueue(queue: ParsedYouTubeUrlQueue): ParsedYouTubeUrlQueue {
  return Object.freeze({
    videoIds: Object.freeze([...queue.videoIds]),
    counts: freezeCounts(queue.counts),
    issues: freezeIssues(queue.issues),
    issuesTruncated: queue.issuesTruncated,
  });
}

function loadFailure(
  reason: "unknown-bundled-queue" | "invalid-bundled-queue",
): BundledYouTubeQueueLoadResult {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ reason }),
  });
}

/**
 * Loads one reviewed queue as immutable normalized IDs and bounded diagnostics.
 * Raw queue text never appears in the result. Loading performs no network,
 * storage, DOM, embed, or playback operation.
 */
export function loadBundledYouTubeQueue(id: string): BundledYouTubeQueueLoadResult {
  const source = SOURCES.find((candidate) => candidate.id === id);
  if (!source) {
    return loadFailure("unknown-bundled-queue");
  }

  const parsed = parseYouTubeUrlQueue(source.text);
  if (
    !parsed.ok ||
    !countsMatch(parsed.queue.counts, source.expectedCounts) ||
    parsed.queue.videoIds.length !== source.itemCount ||
    parsed.queue.issues.length !== source.expectedCounts.malformed ||
    parsed.queue.issuesTruncated
  ) {
    return loadFailure("invalid-bundled-queue");
  }

  return Object.freeze({
    ok: true,
    entry: Object.freeze({
      id: source.id,
      label: source.label,
      queue: freezeQueue(parsed.queue),
    }),
  });
}
