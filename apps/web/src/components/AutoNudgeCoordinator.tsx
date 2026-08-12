import { scopeThreadRef } from "@cafecode/client-runtime";
import { useLocation } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import {
  autoNudgeForegroundThreadFromPathname,
  AutoNudgeCompletionTracker,
  autoNudgeMessageBelongsToTurn,
  autoNudgeRouteKey,
  getAutoNudgeCompletionLedger,
  projectedAutoNudgeAuthority,
  projectedCompletedTurnKey,
  setAutoNudgeCoordinatorStatus,
} from "../autoNudgeCoordinator";
import { useComposerDraftStore } from "../composerDraftStore";
import { readEnvironmentApi } from "../environmentApi";
import { newCommandId, newMessageId } from "../lib/utils";
import { useStore } from "../store";

/**
 * Dispatches Auto Nudge only after a new completed-turn projection arrives.
 * Initial hydration establishes a baseline and never creates authority.
 */
export function AutoNudgeCoordinator() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const environments = useStore((state) => state.environmentStateById);
  const completionTrackerRef = useRef(new AutoNudgeCompletionTracker());
  const pendingCompletionByRouteRef = useRef(new Map<string, string>());
  const inFlightRef = useRef(new Set<string>());

  useEffect(() => {
    const foregroundThread = autoNudgeForegroundThreadFromPathname(pathname);
    const ledger = getAutoNudgeCompletionLedger();
    const liveRoutes = new Set<string>();

    for (const environment of Object.values(environments)) {
      if (!environment.bootstrapComplete) continue;
      for (const threadId of environment.threadIds) {
        const shell = environment.threadShellById[threadId];
        const summary = environment.sidebarThreadSummaryById[threadId];
        if (!shell || !summary) continue;
        const route = { environmentId: shell.environmentId, threadId };
        const routeKey = autoNudgeRouteKey(route);
        liveRoutes.add(routeKey);
        const completionKey = projectedCompletedTurnKey(environment, threadId);
        const newCompletion = completionTrackerRef.current.observe(routeKey, completionKey);
        if (completionKey === null) pendingCompletionByRouteRef.current.delete(routeKey);
        else if (newCompletion !== null)
          pendingCompletionByRouteRef.current.set(routeKey, newCompletion);

        const pendingKey = pendingCompletionByRouteRef.current.get(routeKey);
        if (!pendingKey || pendingKey !== completionKey) continue;
        const config = shell.autoNudge ?? summary.autoNudge;
        const latestTurn =
          environment.threadTurnStateById[threadId]?.latestTurn ?? summary.latestTurn;
        const isForeground =
          foregroundThread?.environmentId === shell.environmentId &&
          foregroundThread.threadId === threadId;
        const terminallyIneligible =
          !config ||
          config.mode === "off" ||
          config.armedAt === null ||
          config.roundsDispatched >= config.maxRounds ||
          shell.archivedAt !== null ||
          latestTurn?.state !== "completed" ||
          latestTurn.completedAt === null ||
          latestTurn.turnId === config.baselineSettledTurnId ||
          latestTurn.turnId === config.lastDispatchedSettledTurnId ||
          (!config.backgroundContinuation && !isForeground);
        if (terminallyIneligible) {
          ledger.mark(pendingKey);
          pendingCompletionByRouteRef.current.delete(routeKey);
          continue;
        }

        const draft = useComposerDraftStore
          .getState()
          .getComposerDraft(scopeThreadRef(shell.environmentId, threadId));
        const manualWorkExists =
          (summary.manualFollowUpCount ?? 0) > 0 ||
          (draft?.prompt.trim().length ?? 0) > 0 ||
          (draft?.images.length ?? 0) > 0 ||
          summary.hasPendingApprovals ||
          summary.hasPendingUserInput ||
          summary.hasActionableProposedPlan ||
          shell.error !== null;
        if (manualWorkExists) {
          ledger.mark(pendingKey);
          pendingCompletionByRouteRef.current.delete(routeKey);
          continue;
        }
        if (
          !config.backgroundContinuation &&
          autoNudgeMessageBelongsToTurn({
            environment,
            threadId,
            messageId: config.lastDispatchedMessageId,
            turnId: latestTurn.turnId,
          })
        ) {
          ledger.mark(pendingKey);
          pendingCompletionByRouteRef.current.delete(routeKey);
          continue;
        }

        const authority = projectedAutoNudgeAuthority({
          environment,
          threadId,
          foregroundThread,
        });
        if (!authority || ledger.has(authority.terminalKey) || inFlightRef.current.has(routeKey)) {
          if (authority && ledger.has(authority.terminalKey)) {
            pendingCompletionByRouteRef.current.delete(routeKey);
          }
          continue;
        }
        const api = readEnvironmentApi(authority.environmentId);
        if (!api) continue;

        ledger.mark(authority.terminalKey);
        pendingCompletionByRouteRef.current.delete(routeKey);
        inFlightRef.current.add(routeKey);
        setAutoNudgeCoordinatorStatus(route, "dispatching");
        void api.orchestration
          .dispatchCommand({
            type: "thread.auto-nudge.dispatch",
            commandId: newCommandId(),
            threadId,
            expectedAuthorityRevision: authority.authorityRevision,
            completedTurnId: authority.completedTurnId,
            dispatchSource: authority.dispatchSource,
            messageId: newMessageId(),
            createdAt: new Date().toISOString(),
          })
          .then(() => setAutoNudgeCoordinatorStatus(route, "waiting"))
          .catch(() => setAutoNudgeCoordinatorStatus(route, "failed"))
          .finally(() => inFlightRef.current.delete(routeKey));
      }
    }

    completionTrackerRef.current.retain(liveRoutes);
    for (const routeKey of pendingCompletionByRouteRef.current.keys()) {
      if (liveRoutes.has(routeKey)) continue;
      pendingCompletionByRouteRef.current.delete(routeKey);
    }
    for (const routeKey of inFlightRef.current) {
      if (!liveRoutes.has(routeKey)) inFlightRef.current.delete(routeKey);
    }
  }, [environments, pathname]);

  return null;
}
