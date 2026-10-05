import type { MessageId, ThreadForkMessageCutoff } from "@cafecode/contracts";
import type { Thread } from "../types";

/** Mirror the server-authorized inclusive prefix, not the renderer's current
 * last message. A bounded detail window may not contain the selected boundary;
 * in that case leave the new chat empty until its authoritative snapshot arrives
 * rather than briefly displaying later messages that were not forked.
 */
export function threadForkPrefix(
  source: Thread,
  cutoff: ThreadForkMessageCutoff,
  retainedMessageIds: ReadonlyArray<MessageId> | undefined,
): Thread | null {
  const index = source.messages.findIndex((message) => message.id === cutoff.sourceMessageId);
  const selected = source.messages[index];
  if (
    !selected ||
    selected.turnId !== cutoff.turnId ||
    selected.streaming ||
    !retainedMessageIds?.includes(selected.id)
  )
    return null;
  // Only the native snapshot's verified lineage establishes membership. Cafe
  // timestamps can tie and generated item IDs are not provider ordering keys.
  const retained = new Set(retainedMessageIds);
  const messages = source.messages.filter((message) => retained.has(message.id));
  const selectedSummary = source.turnDiffSummaries.find(
    (summary) => summary.turnId === cutoff.turnId,
  );
  const turnDiffSummaries = source.turnDiffSummaries.filter(
    (summary) =>
      summary.checkpointTurnCount !== undefined &&
      (summary.checkpointTurnCount < cutoff.retainedTurnCount ||
        (cutoff.includesCompleteTurn && summary.checkpointTurnCount === cutoff.retainedTurnCount)),
  );
  const completeTurns = new Set(turnDiffSummaries.map((summary) => summary.turnId));
  const first = messages.find((message) => message.turnId === cutoff.turnId) ?? selected;
  return {
    ...source,
    messages,
    turnDiffSummaries,
    // Partial turns do not carry later tasks, approvals, plans or file snapshots.
    proposedPlans: source.proposedPlans.filter(
      (plan) => plan.turnId !== null && completeTurns.has(plan.turnId),
    ),
    activities: source.activities.filter(
      (activity) =>
        activity.turnId !== null &&
        completeTurns.has(activity.turnId) &&
        activity.kind !== "approval.requested" &&
        activity.kind !== "user-input.requested",
    ),
    pendingSourceProposedPlan: undefined,
    latestTurn: {
      turnId: cutoff.turnId,
      // A fork is a dormant branch, not proof that this truncated response
      // completed normally. Exact complete-turn checkpoints remain separate.
      state: "interrupted",
      requestedAt: first.createdAt,
      startedAt: first.createdAt,
      completedAt:
        (cutoff.includesCompleteTurn ? selectedSummary?.completedAt : selected.completedAt) ??
        selected.createdAt,
      assistantMessageId: selected.role === "assistant" ? selected.id : null,
    },
  };
}
