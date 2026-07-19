import {
  THREAD_TURN_WORK_LOG_PRESENCE_MAX_TURNS,
  type EnvironmentId,
  type ThreadId,
  type TurnId,
} from "@cafecode/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { HistoricalWorkLogSummary } from "../../session-logic";
import { readEnvironmentApi } from "../../environmentApi";
import {
  filterHistoricalWorkLogSummariesByPresence,
  findHistoricalWorkLogPresenceCandidates,
} from "./MessagesTimeline.logic";

type HistoricalWorkLogSummaries = ReadonlyMap<TurnId, HistoricalWorkLogSummary>;

interface HistoricalWorkLogPresenceState {
  readonly scopeKey: string;
  readonly presenceByTurnId: ReadonlyMap<TurnId, boolean>;
}

const EMPTY_HISTORICAL_WORK_LOG_PRESENCE = new Map<TurnId, boolean>();

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
}): {
  readonly summaries: HistoricalWorkLogSummaries | undefined;
  readonly recordPresence: (turnId: TurnId, hasWorkLog: boolean) => void;
} {
  const scopeKey = `${input.environmentId}\u0000${input.threadId ?? ""}`;
  const [presenceState, setPresenceState] = useState<HistoricalWorkLogPresenceState>({
    scopeKey,
    presenceByTurnId: EMPTY_HISTORICAL_WORK_LOG_PRESENCE,
  });
  const presenceByTurnId =
    presenceState.scopeKey === scopeKey
      ? presenceState.presenceByTurnId
      : EMPTY_HISTORICAL_WORK_LOG_PRESENCE;
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

  useEffect(() => {
    const threadId = input.threadId;
    if (threadId === null || presenceCandidates.length === 0) {
      return;
    }

    let cancelled = false;
    const resolvePresence = async () => {
      const nextPresence = new Map(presenceByTurnId);
      const api = readEnvironmentApi(input.environmentId);
      if (!api) {
        // A disconnected environment cannot prove a row empty. Preserve the
        // old discoverable fallback so reconnecting users can still expand it.
        for (const turnId of presenceCandidates) {
          nextPresence.set(turnId, true);
        }
      } else {
        try {
          for (
            let offset = 0;
            offset < presenceCandidates.length;
            offset += THREAD_TURN_WORK_LOG_PRESENCE_MAX_TURNS
          ) {
            const turnIds = presenceCandidates.slice(
              offset,
              offset + THREAD_TURN_WORK_LOG_PRESENCE_MAX_TURNS,
            );
            const result = await api.orchestration.getThreadTurnWorkLogPresence({
              threadId,
              turnIds,
            });
            const presentTurnIds = new Set(result.turnIdsWithWorkLog);
            for (const turnId of turnIds) {
              nextPresence.set(turnId, presentTurnIds.has(turnId));
            }
          }
        } catch {
          // Transport failure is recoverable and should not erase access to a
          // possibly persisted log. Expansion will retry through the page RPC.
          for (const turnId of presenceCandidates) {
            nextPresence.set(turnId, true);
          }
        }
      }

      if (!cancelled) {
        setPresenceState((current) => {
          const merged = new Map(
            current.scopeKey === scopeKey
              ? current.presenceByTurnId
              : EMPTY_HISTORICAL_WORK_LOG_PRESENCE,
          );
          for (const [turnId, hasWorkLog] of nextPresence) {
            merged.set(turnId, hasWorkLog);
          }
          return { scopeKey, presenceByTurnId: merged };
        });
      }
    };

    void resolvePresence();
    return () => {
      cancelled = true;
    };
  }, [input.environmentId, input.threadId, presenceByTurnId, presenceCandidates, scopeKey]);

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
      setPresenceState((current) => {
        const previous =
          current.scopeKey === scopeKey
            ? current.presenceByTurnId
            : EMPTY_HISTORICAL_WORK_LOG_PRESENCE;
        if (previous.get(turnId) === hasWorkLog) {
          return current;
        }
        const next = new Map(previous);
        next.set(turnId, hasWorkLog);
        return { scopeKey, presenceByTurnId: next };
      });
    },
    [scopeKey],
  );

  return { summaries: visibleSummaries, recordPresence };
}
