import type { ThreadId } from "@cafecode/contracts";
import {
  VISUALIZATION_LIST_PAGE_SIZE,
  type VisualizationListInput,
  type VisualizationListResult,
  type VisualizationTimelineEntry,
} from "@cafecode/contracts/visualizationApi";
import { visualizationEntryIdentity } from "./visualizationEntryIdentity";

/** Received native list visibility is a read-position hint, never execution authority. */
export interface VisualizationHistoryViewport {
  readonly oldestAt: string;
  readonly newestAt: string;
  readonly visibleEntryKeys: readonly string[];
  readonly atEnd: boolean;
}

export interface VisualizationHistoryState {
  readonly entries: readonly VisualizationTimelineEntry[];
  readonly loading: boolean;
  readonly failed: boolean;
}

const MIN_TIME = "0000-01-01T00:00:00.000Z";
const MAX_TIME = "9999-12-31T23:59:59.999Z";
const MAX_REFERENCES = 1_000;
const MAX_PAGES = 20;
const MAX_VISIBLE_KEYS = 128;
// Three history anchors (2,048 characters each), one child ID (200), two UUIDs
// and finite tuple framing. JSON can escape one input character to six bytes.
// Contract-valid copied/forked anchors must not invalidate the whole viewport.
const MAX_ENTRY_KEY_CHARS = 6 * (3 * 2_048 + 200 + 2 * 36 + 5) + 32;

interface PageCoverage {
  readonly upper: string;
  readonly lower: string;
  readonly keys: readonly string[];
  readonly cursor?: string;
  continued: boolean;
}
interface Demand {
  readonly input: VisualizationListInput;
  readonly upper: string;
  readonly parent?: PageCoverage;
}

const canonicalTime = (value: string) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    return false;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value;
};
const demandKey = (demand: Demand) => JSON.stringify(demand.input);

/**
 * One owner-scoped metadata reader. A far-old viewport seeks the indexed time
 * boundary directly; it never walks the intervening history. Cursor pagination
 * is admitted only when the exact last chart of that page is actually visible,
 * including timestamp ties. Sources and frame execution retain their separate
 * authorization, visibility, lifetime and resource admission policies.
 */
export function createVisualizationHistoryController(options: {
  readonly threadId: ThreadId;
  readonly current: () => boolean;
  readonly list: (input: VisualizationListInput) => Promise<VisualizationListResult>;
  readonly publish: (state: VisualizationHistoryState) => void;
}) {
  let closed = false;
  let inFlight = false;
  let latestRequested = false;
  let preferViewport = false;
  let revision = 0;
  let viewport: VisualizationHistoryViewport | null = null;
  let failedDemand: Demand | null = null;
  let retryDemand: Demand | null = null;
  let navigationKey = "";
  let nextViewportEdge: "oldest" | "newest" = "newest";
  const attempted = new Set<string>();
  // Map order is the bounded reference LRU, not untrusted presentation order.
  const retained = new Map<string, VisualizationTimelineEntry>();
  let pages: PageCoverage[] = [];
  const current = () => !closed && options.current();
  const publish = () => {
    if (!current()) return;
    options.publish({
      entries: [...retained.values()].toSorted(
        (a, b) =>
          a.occurredAt.localeCompare(b.occurredAt) ||
          visualizationEntryIdentity(a).localeCompare(visualizationEntryIdentity(b)),
      ),
      loading: inFlight,
      failed: failedDemand !== null,
    });
  };
  const covered = (at: string) => pages.some((page) => page.lower <= at && at <= page.upper);
  const nextDemand = (): Demand | null => {
    if (retryDemand) {
      const demand = retryDemand;
      retryDemand = null;
      return demand;
    }
    if (latestRequested && !preferViewport) {
      latestRequested = false;
      return { input: { threadId: options.threadId }, upper: MAX_TIME };
    }
    if (!viewport) {
      if (!latestRequested) return null;
      latestRequested = false;
      return { input: { threadId: options.threadId }, upper: MAX_TIME };
    }
    // A visible window can straddle two independently cached pages. Admit only
    // its two edges, not every page in a potentially enormous time interval.
    const edges =
      nextViewportEdge === "newest"
        ? [viewport.newestAt, viewport.oldestAt]
        : [viewport.oldestAt, viewport.newestAt];
    for (const at of edges) {
      if (!covered(at)) return { input: { threadId: options.threadId, atOrBefore: at }, upper: at };
    }
    const visible = new Set(viewport.visibleEntryKeys);
    const boundary = pages.find(
      (page) => !page.continued && page.cursor && visible.has(page.keys.at(-1) ?? ""),
    );
    if (boundary?.cursor)
      return {
        input: { threadId: options.threadId, cursor: boundary.cursor },
        upper: boundary.lower,
        parent: boundary,
      };
    if (!latestRequested) return null;
    latestRequested = false;
    return { input: { threadId: options.threadId }, upper: MAX_TIME };
  };
  const pump = () => {
    if (!current() || inFlight) return;
    const demand = nextDemand();
    if (!demand || (failedDemand && demandKey(demand) === demandKey(failedDemand))) return;
    const key = demandKey(demand);
    if (attempted.has(key) || attempted.size >= MAX_PAGES) {
      failedDemand = demand;
      publish();
      return;
    }
    attempted.add(key);
    // A held latest request may accumulate more invalidations. Give the
    // current viewport the next turn before consuming another latest refresh;
    // newest publications cannot perpetually starve historical review.
    preferViewport = demand.input.cursor === undefined && demand.input.atOrBefore === undefined;
    if (demand.input.atOrBefore !== undefined && viewport)
      nextViewportEdge = demand.input.atOrBefore === viewport.newestAt ? "oldest" : "newest";
    inFlight = true;
    const requestRevision = revision;
    failedDemand = null;
    publish();
    // A transport without cancellation still owns its sole permit until it
    // settles. Closing/replacing the owner revokes publication and all trailing
    // dispatch, rather than starting a competing replacement on this reader.
    void Promise.resolve()
      .then(() => (current() ? options.list(demand.input) : null))
      .then((page) => {
        if (!page || !current()) return;
        // An authenticated endpoint still cannot buy an infinite cursor walk.
        // Refuse stalled cursors, out-of-window/non-descending metadata and
        // duplicate invocation keys before mutating the retained window.
        if (
          page.entries.length > VISUALIZATION_LIST_PAGE_SIZE ||
          (page.nextCursor && page.nextCursor === demand.input.cursor) ||
          page.entries.some(
            (entry, index) =>
              !canonicalTime(entry.occurredAt) ||
              entry.occurredAt > demand.upper ||
              (index > 0 && entry.occurredAt > page.entries[index - 1]!.occurredAt),
          ) ||
          new Set(page.entries.map(visualizationEntryIdentity)).size !== page.entries.length
        )
          throw new Error("visualization-history-page-unavailable");
        const keys: string[] = [];
        for (const entry of page.entries) {
          const key = visualizationEntryIdentity(entry);
          const previous = retained.get(key);
          const stable =
            previous && JSON.stringify(previous) === JSON.stringify(entry) ? previous : entry;
          retained.delete(key);
          retained.set(key, stable);
          keys.push(key);
        }
        const protectedKeys = new Set([...keys, ...(viewport?.visibleEntryKeys ?? [])]);
        for (const key of retained.keys()) {
          if (retained.size <= MAX_REFERENCES) break;
          if (!protectedKeys.has(key)) retained.delete(key);
        }
        if (requestRevision === revision) {
          if (demand.parent) demand.parent.continued = true;
          pages = pages.filter((known) => known.keys.every((key) => retained.has(key)));
          pages.push({
            upper: demand.upper,
            lower:
              page.nextCursor && page.entries.length ? page.entries.at(-1)!.occurredAt : MIN_TIME,
            keys,
            ...(page.nextCursor ? { cursor: page.nextCursor } : {}),
            continued: false,
          });
          pages = pages.slice(-MAX_PAGES);
        }
      })
      .catch(() => {
        if (current() && requestRevision === revision) failedDemand = demand;
      })
      .finally(() => {
        inFlight = false;
        if (!current()) return;
        publish();
        pump();
      });
  };
  return {
    invalidate() {
      if (!current()) return;
      // Absence between known rows is a snapshot observation. A live burst can
      // create a gap larger than a page, including backdated native metadata;
      // invalidate coverage, retain stable objects, and re-read only the latest
      // page plus the current viewport edges rather than reconstructing a gap.
      revision += 1;
      pages = [];
      attempted.clear();
      latestRequested = true;
      pump();
    },
    observeViewport(value: VisualizationHistoryViewport) {
      if (
        !current() ||
        !canonicalTime(value.oldestAt) ||
        !canonicalTime(value.newestAt) ||
        value.oldestAt > value.newestAt ||
        typeof value.atEnd !== "boolean" ||
        !Array.isArray(value.visibleEntryKeys) ||
        value.visibleEntryKeys.length > MAX_VISIBLE_KEYS ||
        value.visibleEntryKeys.some(
          (key) => typeof key !== "string" || key.length > MAX_ENTRY_KEY_CHARS,
        )
      )
        return;
      viewport = { ...value, visibleEntryKeys: [...value.visibleEntryKeys] };
      const nextNavigationKey = JSON.stringify([
        value.oldestAt,
        value.newestAt,
        [...value.visibleEntryKeys].toSorted(),
        value.atEnd,
      ]);
      if (navigationKey !== nextNavigationKey) {
        navigationKey = nextNavigationKey;
        attempted.clear();
      }
      // Touch actual visible references so unrelated live invalidations cannot
      // evict/remount the chart currently being read.
      for (const key of viewport.visibleEntryKeys) {
        const entry = retained.get(key);
        if (entry) {
          retained.delete(key);
          retained.set(key, entry);
        }
      }
      if (value.atEnd && !covered(value.newestAt)) latestRequested = true;
      pump();
    },
    retry() {
      if (!current() || !failedDemand) return;
      retryDemand = failedDemand;
      attempted.delete(demandKey(failedDemand));
      failedDemand = null;
      pump();
    },
    close() {
      closed = true;
      retained.clear();
      pages = [];
      viewport = null;
      retryDemand = null;
      failedDemand = null;
      attempted.clear();
    },
  };
}
