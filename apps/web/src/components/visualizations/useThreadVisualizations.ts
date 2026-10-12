import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { EnvironmentId, ThreadId } from "@cafecode/contracts";
import {
  VISUALIZATION_LIST_PAGE_SIZE,
  VisualizationListResult,
  type VisualizationTimelineEntry,
} from "@cafecode/contracts/visualizationApi";
import * as Schema from "effect/Schema";
import { observeVisualizationOwner, useVisualizationTransportRevision } from "./visualizationOwner";
import { visualizationEntryIdentity } from "./visualizationEntryIdentity";

const decodeList = Schema.decodeUnknownSync(VisualizationListResult);
const MAX_RETAINED_REFERENCES = 1_000;
// The authenticated list contract admits at most fifty references per page.
// A disconnected refresh may need explicit gestures to reconstruct the newest
// retained window; never turn that gap into an automatic or unbounded scan.
const MAX_GAP_PAGES = Math.ceil(MAX_RETAINED_REFERENCES / VISUALIZATION_LIST_PAGE_SIZE) - 1;
const EMPTY: readonly VisualizationTimelineEntry[] = [];
type HistoryCommand = "invalidate" | "older" | "latest" | "retry";

/**
 * Durable compact references are read separately from the 500-activity tail.
 * At most one request and one trailing refresh exist for a mounted pane. Token
 * text is intentionally not an invalidation key; older pages require a gesture.
 */
export function useThreadVisualizations(
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
  foreground: boolean,
  revision: string,
) {
  const scope = JSON.stringify([environmentId, threadId]);
  const transportRevision = useVisualizationTransportRevision(environmentId);
  const previousRevision = useRef({ scope, revision });
  const committed = useRef(scope);
  const generation = useRef(0);
  const request = useRef<((command: HistoryCommand) => void) | null>(null);
  const [state, setState] = useState<{
    scope: string;
    entries: readonly VisualizationTimelineEntry[];
    nextCursor?: string;
    failed: boolean;
    loading: boolean;
    reviewingOlder: boolean;
  }>({ scope, entries: EMPTY, failed: false, loading: false, reviewingOlder: false });
  useLayoutEffect(() => {
    committed.current = scope;
    return () => {
      generation.current += 1;
    };
  }, [scope]);
  useEffect(() => {
    if (!foreground || !threadId) return;
    const token = ++generation.current;
    let stopped = false;
    let inflight = false;
    let trailing: "invalidate" | "latest" | null = null;
    let modeEpoch = 0;
    let reviewingOlder = false;
    let replacingWithLatest = false;
    // Retention follows authenticated page order, not received timestamps. A
    // backdated historical entry must never be dropped while its cursor moves.
    let entries: readonly VisualizationTimelineEntry[] = EMPTY;
    let displayedEntries: readonly VisualizationTimelineEntry[] = EMPTY;
    let cursor: string | undefined;
    let latestHeadEntryKey: string | undefined;
    let gap: {
      boundary: string;
      resumeCursor?: string;
      remainingPages: number;
      insertAfter: string;
      trimmed: boolean;
    } | null = null;
    let failedRequest: { older: boolean; cursor?: string } | null = null;
    const owner = observeVisualizationOwner(environmentId, () => {
      stopped = true;
      setState({ scope, entries: EMPTY, failed: true, loading: false, reviewingOlder: false });
    });
    const current = () =>
      !stopped && committed.current === scope && generation.current === token && owner.current();
    const publish = (failed: boolean, loading: boolean) =>
      setState({
        scope,
        entries: displayedEntries,
        ...(cursor && !replacingWithLatest ? { nextCursor: cursor } : {}),
        failed,
        loading,
        reviewingOlder,
      });
    const refresh = (command: HistoryCommand) => {
      if (!current() || !owner.api?.visualizations) return;
      if (command === "latest") {
        if (!reviewingOlder) return;
        // Revoke the response epoch synchronously at this explicit gesture.
        // Keep the current inert review window until its replacement arrives,
        // but never merge an older ACK or dispatch a competing list request.
        modeEpoch += 1;
        reviewingOlder = false;
        replacingWithLatest = true;
        cursor = undefined;
        gap = null;
        latestHeadEntryKey = undefined;
        failedRequest = null;
        publish(false, true);
      } else if (command === "invalidate" && reviewingOlder) return;
      if (inflight) {
        if (command === "latest") trailing = "latest";
        else if (command === "invalidate" && trailing !== "latest") trailing = "invalidate";
        return;
      }
      let older = command === "older";
      let requestedCursor = cursor;
      if (command === "retry") {
        if (!failedRequest) return;
        older = failedRequest.older;
        requestedCursor = failedRequest.cursor;
      }
      if (older && !requestedCursor) return;
      if (older && !gap && entries.length >= MAX_RETAINED_REFERENCES && !reviewingOlder) {
        // Only a user-requested page beyond the connected latest window enters
        // review. New live invalidations are then ignored, not saved in a queue.
        modeEpoch += 1;
        reviewingOlder = true;
        trailing = null;
      }
      const epoch = modeEpoch;
      const reviewMode = reviewingOlder;
      const replacement = replacingWithLatest;
      const input = { threadId, ...(older && requestedCursor ? { cursor: requestedCursor } : {}) };
      inflight = true;
      failedRequest = null;
      publish(false, true);
      void owner.api.visualizations
        .list(input)
        .then((raw) => {
          if (!current() || epoch !== modeEpoch || reviewMode !== reviewingOlder) return;
          const page = decodeList(raw);
          const merged = new Map(
            (replacement ? EMPTY : entries).map((entry) => [
              visualizationEntryIdentity(entry),
              entry,
            ]),
          );
          const overlapsRetained = page.entries.some((entry) =>
            merged.has(visualizationEntryIdentity(entry)),
          );
          const incoming = page.entries.map((entry) => {
            const old = merged.get(visualizationEntryIdentity(entry));
            // Stable overlap identities keep settled virtual rows from
            // redrawing. Only compact, source-free metadata is compared here.
            return old && JSON.stringify(old) === JSON.stringify(entry) ? old : entry;
          });
          const incomingIds = new Set(incoming.map(visualizationEntryIdentity));
          const previous = (replacement ? EMPTY : entries).filter(
            (entry) => !incomingIds.has(visualizationEntryIdentity(entry)),
          );
          let ordered: readonly VisualizationTimelineEntry[];
          if (older && gap && incoming.length) {
            // A gap page belongs directly after its exact last admitted page,
            // before the previously known tail. Never append it behind that
            // tail or let timestamp ordering discard newly discovered rows.
            const insertion = previous.findIndex(
              (entry) => visualizationEntryIdentity(entry) === gap!.insertAfter,
            );
            if (insertion < 0) throw new Error("visualization-history-gap-unavailable");
            ordered = [
              ...previous.slice(0, insertion + 1),
              ...incoming,
              ...previous.slice(insertion + 1),
            ];
          } else if (older) {
            const incomingById = new Map(
              incoming.map((entry) => [visualizationEntryIdentity(entry), entry]),
            );
            // Re-reading a known overlap after capped gap reconstruction must
            // not move that overlap behind a newer continuation and corrupt
            // retention order. Replace metadata in place, append only new rows.
            ordered = [
              ...entries.map(
                (entry) => incomingById.get(visualizationEntryIdentity(entry)) ?? entry,
              ),
              ...incoming.filter((entry) => !merged.has(visualizationEntryIdentity(entry))),
            ];
          } else ordered = [...incoming, ...previous];
          const trimmed = ordered.length > MAX_RETAINED_REFERENCES;
          if (replacement) {
            cursor = page.nextCursor;
            gap = null;
            latestHeadEntryKey = page.entries[0] && visualizationEntryIdentity(page.entries[0]);
            replacingWithLatest = false;
          } else if (!older) {
            if (page.entries.length && entries.length && (!overlapsRetained || trimmed)) {
              // Keeping the previous older cursor would skip a burst larger
              // than one page. Retain the original connected head/cursor even
              // through later bursts, so touching a newly known head cannot
              // incorrectly declare a still-disconnected older gap complete.
              gap ??= {
                boundary: latestHeadEntryKey ?? visualizationEntryIdentity(entries[0]!),
                ...(cursor ? { resumeCursor: cursor } : {}),
                remainingPages: MAX_GAP_PAGES,
                insertAfter: visualizationEntryIdentity(page.entries.at(-1)!),
                trimmed,
              };
              gap.remainingPages = MAX_GAP_PAGES;
              gap.insertAfter = visualizationEntryIdentity(page.entries.at(-1)!);
              gap.trimmed ||= trimmed;
              cursor = page.nextCursor;
            } else if (!cursor) cursor = page.nextCursor;
            latestHeadEntryKey = page.entries[0]
              ? visualizationEntryIdentity(page.entries[0])
              : latestHeadEntryKey;
          } else {
            cursor = page.nextCursor;
            if (gap) {
              const boundary = gap.boundary;
              gap.remainingPages -= 1;
              gap.trimmed ||= trimmed;
              gap.insertAfter = page.entries.at(-1)
                ? visualizationEntryIdentity(page.entries.at(-1)!)
                : gap.insertAfter;
              if (page.entries.some((entry) => visualizationEntryIdentity(entry) === boundary)) {
                // A trimmed known tail is no longer in memory. Its old cursor
                // would skip those evicted rows, so retain this exact page's
                // continuation instead. Explicit overlap pages are bounded.
                if (!gap.trimmed) cursor = gap.resumeCursor;
                gap = null;
              } else if (gap.remainingPages === 0) gap = null;
            }
          }
          if (!cursor) gap = null;
          // Latest/gap reconstruction keeps the newest bounded window. Explicit
          // older review keeps the admitted older rows and evicts newest ones,
          // so advancing a cursor never strands newly read historical cards.
          entries = reviewMode
            ? ordered.slice(-MAX_RETAINED_REFERENCES)
            : ordered.slice(0, MAX_RETAINED_REFERENCES);
          displayedEntries = entries.toSorted((a, b) => a.occurredAt.localeCompare(b.occurredAt));
          publish(false, false);
        })
        .catch(() => {
          if (current() && epoch === modeEpoch && reviewMode === reviewingOlder) {
            failedRequest = { older, ...(input.cursor ? { cursor: input.cursor } : {}) };
            publish(true, false);
          }
        })
        .finally(() => {
          inflight = false;
          if (trailing && current()) {
            const next = trailing;
            trailing = null;
            // Return-to-latest already changed the epoch/mode above. Dispatch
            // that one replacement without repeating the mode transition.
            refresh(next === "latest" ? "invalidate" : next);
          }
        });
    };
    request.current = refresh;
    refresh("invalidate");
    return () => {
      stopped = true;
      request.current = null;
      owner.dispose();
    };
  }, [environmentId, threadId, foreground, scope, transportRevision]);
  useEffect(() => {
    const previous = previousRevision.current;
    previousRevision.current = { scope, revision };
    if (previous.scope === scope && previous.revision !== revision) request.current?.("invalidate");
  }, [scope, revision]);
  return {
    entries: state.scope === scope && foreground ? state.entries : EMPTY,
    failed: state.scope === scope && state.failed,
    loading: state.scope === scope && state.loading,
    hasOlder: state.scope === scope && !!state.nextCursor,
    reviewingOlder: state.scope === scope && foreground && state.reviewingOlder,
    loadOlder: useCallback(() => request.current?.("older"), []),
    returnToLatest: useCallback(() => request.current?.("latest"), []),
    refresh: useCallback(() => request.current?.("retry"), []),
  };
}
