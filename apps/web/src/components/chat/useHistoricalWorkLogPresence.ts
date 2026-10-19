import {
  THREAD_TURN_WORK_LOG_PRESENCE_MAX_TURNS,
  type EnvironmentId,
  type ThreadId,
  type TurnId,
  type OrchestrationThreadTurnWorkLogPresenceResult,
} from "@cafecode/contracts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { HistoricalWorkLogSummary } from "../../session-logic";
import { readEnvironmentApi } from "../../environmentApi";
import {
  filterHistoricalWorkLogSummariesByPresence,
  findHistoricalWorkLogPresenceCandidates,
  preservesEarlierWorkLogPresence,
  type EarlierWorkLogPresenceFilters,
} from "./MessagesTimeline.logic";

type HistoricalWorkLogSummaries = ReadonlyMap<TurnId, HistoricalWorkLogSummary>;

interface HistoricalWorkLogPresenceState {
  readonly scopeKey: string;
  /** Undefined is an attempted but inconclusive read, never presence proof. */
  readonly presenceByTurnId: ReadonlyMap<TurnId, boolean | undefined>;
  readonly revisionByTurnId: ReadonlyMap<TurnId, HistoricalWorkLogPresenceRevision>;
}

interface HistoricalWorkLogPresenceRevision {
  readonly key: string;
  readonly filters: EarlierWorkLogPresenceFilters;
}

const EMPTY_HISTORICAL_WORK_LOG_PRESENCE = new Map<TurnId, boolean | undefined>();

function presenceRevision(
  summary: HistoricalWorkLogSummary | undefined,
  historyRevision?: string,
  hasWorkLog = false,
): string {
  // A growing earlier range cannot invalidate positive proof. Its exclusions
  // can: received settings may make that proof redundant with inline content.
  // Negatives/inconclusive reads still expire when actual work is evicted.
  const growingPositiveRange = hasWorkLog && summary?.before !== undefined;
  return JSON.stringify([
    growingPositiveRange ? "" : (historyRevision ?? ""),
    growingPositiveRange ? "" : (summary?.presenceRevision ?? ""),
    summary?.excludeActivityIds ?? [],
    summary?.excludeOperations ?? [],
    summary?.excludeTurnStartAck ?? false,
  ]);
}

function capturePresenceRevision(
  summary: HistoricalWorkLogSummary | undefined,
  historyRevision: string | undefined,
  hasWorkLog: boolean,
): HistoricalWorkLogPresenceRevision {
  return {
    key: presenceRevision(summary, historyRevision, hasWorkLog),
    filters: {
      ...(summary?.excludeActivityIds ? { excludeActivityIds: summary.excludeActivityIds } : {}),
      ...(summary?.excludeOperations ? { excludeOperations: summary.excludeOperations } : {}),
      ...(summary?.excludeTurnStartAck !== undefined
        ? { excludeTurnStartAck: summary.excludeTurnStartAck }
        : {}),
    },
  };
}

function useStableTurnIds(turnIds: ReadonlyArray<TurnId>): ReadonlyArray<TurnId> {
  const stableRef = useRef<ReadonlyArray<TurnId>>([]);
  const previous = stableRef.current;
  if (
    previous.length !== turnIds.length ||
    previous.some((turnId, index) => turnId !== turnIds[index])
  ) {
    stableRef.current = turnIds;
  }
  return stableRef.current;
}

export function useHistoricalWorkLogPresence(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly summaries: HistoricalWorkLogSummaries | undefined;
  readonly historyRevision?: string | undefined;
}): {
  readonly summaries: HistoricalWorkLogSummaries | undefined;
  readonly recordPresence: (turnId: TurnId, hasWorkLog: boolean) => void;
} {
  const scopeKey = `${input.environmentId}\u0000${input.threadId ?? ""}`;
  // Read metadata at request creation, without making streamed summary object
  // identities a dependency. Only the bounded work witness below restarts RPCs.
  const metadataRef = useRef({
    scopeKey,
    summaries: input.summaries,
    historyRevision: input.historyRevision,
  });
  const requestCacheRef = useRef({
    scopeKey,
    reads: new Map<string, Promise<OrchestrationThreadTurnWorkLogPresenceResult>>(),
  });
  useLayoutEffect(() => {
    // Only committed ownership may govern an asynchronous publication. A
    // speculative render must not alter the previous mounted reader's owner.
    metadataRef.current = {
      scopeKey,
      summaries: input.summaries,
      historyRevision: input.historyRevision,
    };
    if (requestCacheRef.current.scopeKey !== scopeKey) {
      requestCacheRef.current = { scopeKey, reads: new Map() };
    }
  }, [scopeKey, input.summaries, input.historyRevision]);
  const [presenceState, setPresenceState] = useState<HistoricalWorkLogPresenceState>({
    scopeKey,
    presenceByTurnId: EMPTY_HISTORICAL_WORK_LOG_PRESENCE,
    revisionByTurnId: new Map(),
  });
  const revisionForTurn = useCallback(
    (turnId: TurnId, hasWorkLog = false) =>
      presenceRevision(input.summaries?.get(turnId), input.historyRevision, hasWorkLog),
    [input.historyRevision, input.summaries],
  );
  const snapshotPositiveIds = useStableTurnIds(
    [...(input.summaries?.values() ?? [])]
      .filter((summary) => summary.snapshotEntryCount > 0 || summary.previewEntries.length > 0)
      .map((summary) => summary.turnId),
  );
  useEffect(() => {
    if (snapshotPositiveIds.length === 0 || metadataRef.current.scopeKey !== scopeKey) return;
    setPresenceState((current) => {
      if (metadataRef.current.scopeKey !== scopeKey) return current;
      const sameOwner = current.scopeKey === scopeKey;
      if (
        sameOwner &&
        snapshotPositiveIds.every((turnId) => current.presenceByTurnId.get(turnId) === true)
      )
        return current;
      const merged = new Map(sameOwner ? current.presenceByTurnId : []);
      const revisions = new Map(sameOwner ? current.revisionByTurnId : []);
      for (const turnId of merged.keys()) {
        if (!metadataRef.current.summaries?.has(turnId)) {
          merged.delete(turnId);
          revisions.delete(turnId);
        }
      }
      for (const turnId of snapshotPositiveIds) merged.set(turnId, true);
      return {
        scopeKey,
        presenceByTurnId: merged,
        revisionByTurnId: revisions,
      };
    });
  }, [scopeKey, snapshotPositiveIds]);
  const presenceByTurnId = useMemo(() => {
    if (presenceState.scopeKey !== scopeKey) return EMPTY_HISTORICAL_WORK_LOG_PRESENCE;
    const valid = new Map<TurnId, boolean | undefined>();
    for (const [turnId, present] of presenceState.presenceByTurnId) {
      const summary = input.summaries?.get(turnId);
      const revision = presenceState.revisionByTurnId.get(turnId);
      // Earlier-work positives also belong to their exact filters: newly
      // received settings can replace the only saved start receipt. Keeping
      // that old positive would advertise an empty reader until expansion.
      // Previous-turn snapshot proof stays discoverable after eviction. The
      // witness still ignores context-only updates and message tokens. Removing
      // exclusions only widens a proven earlier range; retaining that positive
      // also preserves an already-open reader instead of unmounting it briefly.
      if (
        (present && !summary?.before) ||
        revision?.key === revisionForTurn(turnId, present === true) ||
        (present &&
          summary?.before &&
          revision &&
          preservesEarlierWorkLogPresence(revision.filters, summary))
      ) {
        valid.set(turnId, present);
      }
    }
    return valid;
  }, [input.summaries, presenceState, revisionForTurn, scopeKey]);
  const presenceCandidates = useStableTurnIds(
    useMemo(
      () =>
        input.summaries
          ? findHistoricalWorkLogPresenceCandidates({
              summaries: input.summaries,
              presenceByTurnId,
            })
          : [],
      [input.summaries, presenceByTurnId],
    ),
  );
  // A witness may change while the same candidate id is in flight. Its old
  // negative must be cancelled and retried, not stranded behind stable ids.
  const candidateRevision = JSON.stringify(
    presenceCandidates.map((turnId) => [turnId, revisionForTurn(turnId)]),
  );

  useEffect(() => {
    const threadId = input.threadId;
    if (threadId === null || presenceCandidates.length === 0) {
      return;
    }

    let cancelled = false;
    // Snapshot request metadata once. Publishing a batch may restart this
    // effect with only the unresolved candidates; never depend on per-token
    // summary object identity while a read is in flight.
    const { summaries: requestedSummaries, historyRevision: requestedRevision } =
      metadataRef.current;
    if (
      candidateRevision !==
      JSON.stringify(
        presenceCandidates.map((id) => [
          id,
          presenceRevision(requestedSummaries?.get(id), requestedRevision),
        ]),
      )
    )
      return;
    const publish = (
      turnIds: ReadonlyArray<TurnId>,
      presentTurnIds: ReadonlySet<TurnId>,
      unavailable = false,
    ) => {
      if (cancelled || metadataRef.current.scopeKey !== scopeKey) return;
      setPresenceState((current) => {
        if (cancelled || metadataRef.current.scopeKey !== scopeKey) return current;
        const sameOwner = current.scopeKey === scopeKey;
        const merged = new Map(
          sameOwner ? current.presenceByTurnId : EMPTY_HISTORICAL_WORK_LOG_PRESENCE,
        );
        const revisions = new Map(sameOwner ? current.revisionByTurnId : []);
        for (const turnId of turnIds) {
          const present =
            unavailable && requestedSummaries?.get(turnId)?.before
              ? undefined
              : presentTurnIds.has(turnId);
          merged.set(turnId, present);
          revisions.set(
            turnId,
            capturePresenceRevision(
              requestedSummaries?.get(turnId),
              requestedRevision,
              present === true,
            ),
          );
        }
        // Bound cache ownership to the same retained candidate set; an old
        // thousand-message window must not accumulate unreachable negatives.
        for (const turnId of merged.keys()) {
          if (!requestedSummaries?.has(turnId)) {
            merged.delete(turnId);
            revisions.delete(turnId);
          }
        }
        return { scopeKey, presenceByTurnId: merged, revisionByTurnId: revisions };
      });
    };
    const resolvePresence = async () => {
      const unresolved = new Set(presenceCandidates);
      const api = readEnvironmentApi(input.environmentId);
      if (!api) {
        // No result is not evidence of earlier work. Remember an inconclusive
        // attempt for this witness without displaying an empty disclosure or
        // starting a history retry loop. A new witness/remount can check again.
        // Preserve the existing previous-turn fallback independently.
        publish(presenceCandidates, new Set(presenceCandidates), true);
      } else {
        try {
          const readPresence = (
            turnIds: ReadonlyArray<TurnId>,
            before?: HistoricalWorkLogSummary["before"],
          ) => {
            // Incremental publication changes the unresolved candidate list.
            // Reuse its pending/completed bounded read so React's effect
            // cleanup cannot duplicate the next batch already dispatched.
            const key = JSON.stringify([
              before ? "earlier" : "historical",
              turnIds.map((id) => [
                id,
                presenceRevision(requestedSummaries?.get(id), requestedRevision),
              ]),
            ]);
            const cache = requestCacheRef.current;
            const existing = cache.reads.get(key);
            if (existing) return existing;
            const excludeActivityIds = before
              ? requestedSummaries?.get(turnIds[0]!)?.excludeActivityIds
              : undefined;
            const excludeTurnStartAck = before
              ? requestedSummaries?.get(turnIds[0]!)?.excludeTurnStartAck
              : undefined;
            const excludeOperations = before
              ? requestedSummaries?.get(turnIds[0]!)?.excludeOperations
              : undefined;
            const read = api.orchestration.getThreadTurnWorkLogPresence({
              threadId,
              turnIds,
              ...(before ? { before } : {}),
              ...(excludeActivityIds ? { excludeActivityIds } : {}),
              ...(excludeOperations ? { excludeOperations } : {}),
              ...(excludeTurnStartAck !== undefined ? { excludeTurnStartAck } : {}),
            });
            cache.reads.set(key, read);
            // A focused timeline has a bounded turn set. Retain at most16
            // batch receipts, not a growing lifetime per-token cache.
            while (cache.reads.size > 16) cache.reads.delete(cache.reads.keys().next().value!);
            return read;
          };
          const historicalCandidates = presenceCandidates.filter(
            (turnId) => !requestedSummaries?.get(turnId)?.before,
          );
          for (
            let offset = 0;
            offset < historicalCandidates.length;
            offset += THREAD_TURN_WORK_LOG_PRESENCE_MAX_TURNS
          ) {
            if (cancelled) break;
            const turnIds = historicalCandidates.slice(
              offset,
              offset + THREAD_TURN_WORK_LOG_PRESENCE_MAX_TURNS,
            );
            const result = await readPresence(turnIds);
            if (
              result.threadId !== threadId ||
              result.turnIdsWithWorkLog.some((turnId) => !turnIds.includes(turnId))
            )
              throw new Error("Invalid history presence scope");
            const presentTurnIds = new Set(result.turnIdsWithWorkLog);
            publish(turnIds, presentTurnIds);
            for (const turnId of turnIds) unresolved.delete(turnId);
          }
          for (const turnId of presenceCandidates) {
            const before = requestedSummaries?.get(turnId)?.before;
            if (!before || cancelled) continue;
            const result = await readPresence([turnId], before);
            if (
              result.threadId !== threadId ||
              result.turnIdsWithWorkLog.some((id) => id !== turnId)
            )
              throw new Error("Invalid earlier presence scope");
            publish([turnId], new Set(result.turnIdsWithWorkLog));
            unresolved.delete(turnId);
          }
        } catch {
          // An inconclusive Earlier work check stays hidden rather than
          // manufacturing a positive. Already proven rows remain untouched;
          // previous-turn Work logs retain their existing fallback behavior.
          publish([...unresolved], unresolved, true);
        }
      }
    };

    void resolvePresence();
    return () => {
      cancelled = true;
    };
    // Candidate ids are deliberately stable across changes to received text.
    // The revision-aware candidate derivation restarts only for relevant gaps.
  }, [input.environmentId, input.threadId, presenceCandidates, candidateRevision, scopeKey]);

  const visibleSummaries = useMemo(() => {
    if (!input.summaries) {
      return undefined;
    }
    return filterHistoricalWorkLogSummariesByPresence({
      summaries: input.summaries,
      presenceByTurnId,
    });
  }, [input.summaries, presenceByTurnId]);
  const recordPresence = useCallback(
    (turnId: TurnId, hasWorkLog: boolean) => {
      const metadata = metadataRef.current;
      if (metadata.scopeKey !== scopeKey) return;
      const revision = capturePresenceRevision(
        metadata.summaries?.get(turnId),
        metadata.historyRevision,
        hasWorkLog,
      );
      setPresenceState((current) => {
        if (metadataRef.current.scopeKey !== scopeKey) return current;
        const previous =
          current.scopeKey === scopeKey
            ? current.presenceByTurnId
            : EMPTY_HISTORICAL_WORK_LOG_PRESENCE;
        if (
          previous.get(turnId) === hasWorkLog &&
          current.revisionByTurnId.get(turnId)?.key === revision.key
        ) {
          return current;
        }
        const next = new Map(previous);
        next.set(turnId, hasWorkLog);
        const revisions = new Map(current.scopeKey === scopeKey ? current.revisionByTurnId : []);
        revisions.set(turnId, revision);
        return { scopeKey, presenceByTurnId: next, revisionByTurnId: revisions };
      });
    },
    [scopeKey],
  );

  return { summaries: visibleSummaries, recordPresence };
}
