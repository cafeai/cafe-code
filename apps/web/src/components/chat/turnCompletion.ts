import type { OrchestrationLiveWork } from "@cafecode/contracts";
import { uiText } from "@cafecode/shared/i18n";
import { deriveLiveWorkObservations, isLiveWorkRuntimeCurrent } from "@cafecode/shared/liveWork";
import { deriveCodexRecoveryPresentation } from "../../codexRecovery";
import {
  deriveActiveSubagentWorkEntries,
  formatElapsed,
  hasToolActivityForTurn,
  isLatestTurnSettled,
} from "../../session-logic";
import type { Thread } from "../../types";

/**
 * A completed root duration is history, not evidence that its whole native
 * context has ended. Qualify any ongoing label against this thread's current
 * runtime and the existing exact account/generation recovery presenter. Never
 * change terminal state, infer activity from elapsed time, or grant Stop/retry
 * authority from this display label.
 */
export function deriveTurnCompletionSummary(input: {
  readonly thread: Pick<Thread, "session" | "latestTurn" | "archivedAt" | "activities"> | undefined;
  readonly liveWork?: OrchestrationLiveWork | undefined;
}): string | null {
  const thread = input.thread;
  const turn = thread?.latestTurn;
  if (
    !thread ||
    !turn?.startedAt ||
    !turn.completedAt ||
    !isLatestTurnSettled(turn, thread.session) ||
    !hasToolActivityForTurn(thread.activities, turn.turnId)
  )
    return null;
  const elapsed = formatElapsed(turn.startedAt, turn.completedAt);
  if (!elapsed) return null;

  const session = thread.session;
  const runtimeSession =
    thread.archivedAt === null &&
    session?.providerInstanceId &&
    (session.status === "ready" || session.status === "running")
      ? {
          subagentRuntimeId: session.subagentRuntimeId,
          orchestrationStatus: session.orchestrationStatus,
        }
      : null;
  const summary = isLiveWorkRuntimeCurrent(input.liveWork?.runtimeId, runtimeSession)
    ? input.liveWork
    : undefined;
  // An authoritative zero retracts stale rows in the local transcript tail.
  // Absence remains unknown, so current bound lifecycle heads may still help.
  const activeSubagents =
    summary?.agentCount === 0
      ? []
      : deriveActiveSubagentWorkEntries(thread.activities, null, { runtimeSession });
  const recovery = deriveCodexRecoveryPresentation({
    thread,
    activities: thread.activities,
    activeSubagents,
  });
  if (recovery?.stage === "uncertain")
    return uiText("Needs reconciliation · root {elapsed}", { elapsed });
  if (recovery?.stage) return uiText("Reconnecting · root {elapsed}", { elapsed });
  const agentCount = summary?.agentCount ?? activeSubagents.length;
  if (agentCount > 0) return uiText("Agents running · root {elapsed}", { elapsed });
  const taskCount =
    summary?.taskCount ??
    deriveLiveWorkObservations(thread.activities, runtimeSession).filter(
      ({ observation }) => !observation.agent,
    ).length;
  if (taskCount > 0) return uiText("Tasks running · root {elapsed}", { elapsed });
  return uiText("Worked for {elapsed}", { elapsed });
}
