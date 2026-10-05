import type { MessageId, OrchestrationThread, ThreadForkMessageCutoff } from "@cafecode/contracts";

/** Resolve only durable Cafe identities. Native message lookup belongs to the
 * exact account's adapter; public callers never supply a provider UUID.
 */
export function resolveThreadForkMessageCutoff(
  source: OrchestrationThread,
  messageId: MessageId,
): ThreadForkMessageCutoff {
  const message = source.messages.find((entry) => entry.id === messageId);
  if (
    !message ||
    message.streaming ||
    message.turnId === null ||
    (message.role !== "user" && message.role !== "assistant")
  )
    throw new Error("The selected message is unavailable or has not finished.");
  const checkpoints = source.checkpoints.filter((entry) => entry.turnId === message.turnId);
  const checkpoint = checkpoints[0];
  if (
    checkpoints.length === 0 &&
    source.latestTurn?.turnId === message.turnId &&
    source.latestTurn.state === "interrupted"
  ) {
    // A previous selected fork deliberately removed this partial turn's file
    // checkpoint. Infer only its projection ordinal; the provider independently
    // requires equality with its durable exact-message ordinal before I/O.
    return {
      sourceMessageId: messageId,
      turnId: message.turnId,
      retainedTurnCount:
        Math.max(0, ...source.checkpoints.map((entry) => entry.checkpointTurnCount)) + 1,
      includesCompleteTurn: false,
    };
  }
  if (checkpoints.length !== 1 || !checkpoint || checkpoint.checkpointTurnCount < 1)
    throw new Error("The selected message has no exact persisted turn boundary.");
  return {
    sourceMessageId: messageId,
    turnId: message.turnId,
    retainedTurnCount: checkpoint.checkpointTurnCount,
    includesCompleteTurn:
      message.role === "assistant" && checkpoint.assistantMessageId === messageId,
  };
}

/** Construct the same inclusive prefix used by SQL and renderer projections.
 * Forking an intermediate message does not claim its later turn completion,
 * filesystem checkpoint, work log or proposed plan. File contents themselves
 * are never changed by this operation.
 */
export function threadForkPrefix(
  source: OrchestrationThread,
  cutoff: ThreadForkMessageCutoff,
  retainedMessageIds?: ReadonlyArray<MessageId>,
): OrchestrationThread {
  const resolved = resolveThreadForkMessageCutoff(source, cutoff.sourceMessageId);
  if (JSON.stringify(resolved) !== JSON.stringify(cutoff))
    throw new Error("The selected fork boundary changed.");
  if (
    !retainedMessageIds ||
    !retainedMessageIds.includes(cutoff.sourceMessageId) ||
    retainedMessageIds.some((id) => !source.messages.some((message) => message.id === id))
  )
    throw new Error("The selected fork has no native-proven projection prefix.");
  const retained = new Set(retainedMessageIds);
  const messages = source.messages.filter((entry) => retained.has(entry.id));
  const checkpoints = source.checkpoints.filter(
    (entry) =>
      entry.checkpointTurnCount < cutoff.retainedTurnCount ||
      (cutoff.includesCompleteTurn && entry.checkpointTurnCount === cutoff.retainedTurnCount),
  );
  const completeTurnIds = new Set(checkpoints.map((entry) => entry.turnId));
  const selected = messages.find((entry) => entry.id === cutoff.sourceMessageId)!;
  const selectedCheckpoint = source.checkpoints.find((entry) => entry.turnId === cutoff.turnId);
  return {
    ...source,
    messages,
    checkpoints,
    proposedPlans: source.proposedPlans.filter(
      (entry) => entry.turnId !== null && completeTurnIds.has(entry.turnId),
    ),
    // Historical terminal work-log rows remain useful, but source request
    // handles never become approval/input controls in the new conversation.
    activities: source.activities.filter(
      (entry) =>
        entry.turnId !== null &&
        completeTurnIds.has(entry.turnId) &&
        entry.kind !== "approval.requested" &&
        entry.kind !== "user-input.requested",
    ),
    latestTurn: {
      turnId: cutoff.turnId,
      state: "interrupted",
      requestedAt:
        messages.find((entry) => entry.turnId === cutoff.turnId)?.createdAt ?? selected.createdAt,
      startedAt:
        messages.find((entry) => entry.turnId === cutoff.turnId)?.createdAt ?? selected.createdAt,
      completedAt: cutoff.includesCompleteTurn
        ? selectedCheckpoint!.completedAt
        : selected.updatedAt,
      assistantMessageId: selected.role === "assistant" ? selected.id : null,
    },
  };
}
