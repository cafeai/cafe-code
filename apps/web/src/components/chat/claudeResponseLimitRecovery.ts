import type { EnvironmentId, ProviderInstanceId, ThreadId, TurnId } from "@cafecode/contracts";
import { isClaudeResponseLimitError } from "@cafecode/shared/claudeResponseLimits";

import type { ComposerThreadDraftState } from "../../composerDraftStore";
import type { Thread } from "../../types";

type ClaudeFailureThread = Pick<
  Thread,
  "id" | "environmentId" | "archivedAt" | "error" | "session" | "latestTurn" | "modelSelection"
>;

/** Local presentation authority only. Preparing this draft never submits provider work. */
export interface ClaudeResponseLimitFailure {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  instanceId: ProviderInstanceId;
  turnId: TurnId;
  completedAt: string;
  sessionCreatedAt: string;
  sessionUpdatedAt: string;
  runtimeId: string | null;
}

/**
 * Require the classified provider failure and the exact currently selected account.
 * Unknown legacy ownership is insufficient: another account must not inherit a
 * continuation action merely because the chat still contains the same error text.
 */
export function captureClaudeResponseLimitFailure(
  thread: ClaudeFailureThread | undefined,
  selectedInstanceId: ProviderInstanceId | null,
): ClaudeResponseLimitFailure | null {
  const session = thread?.session;
  const turn = thread?.latestTurn;
  if (
    !thread ||
    thread.archivedAt !== null ||
    !thread.error ||
    !isClaudeResponseLimitError(thread.error) ||
    session?.lastError !== thread.error ||
    session.provider !== "claudeAgent" ||
    session.orchestrationStatus !== "error" ||
    session.status !== "error" ||
    session.activeTurnId !== undefined ||
    !session.providerInstanceId ||
    session.providerInstanceId !== selectedInstanceId ||
    thread.modelSelection.instanceId !== selectedInstanceId ||
    turn?.state !== "error" ||
    !turn.startedAt ||
    !turn.completedAt
  ) {
    return null;
  }
  return {
    environmentId: thread.environmentId,
    threadId: thread.id,
    instanceId: session.providerInstanceId,
    turnId: turn.turnId,
    completedAt: turn.completedAt,
    sessionCreatedAt: session.createdAt,
    sessionUpdatedAt: session.updatedAt,
    runtimeId: session.subagentRuntimeId ?? null,
  };
}

/** Recheck the rendered occurrence immediately before changing an editable draft. */
export function isClaudeResponseLimitFailureCurrent(
  expected: ClaudeResponseLimitFailure,
  thread: ClaudeFailureThread | undefined,
  selectedInstanceId: ProviderInstanceId | null,
): boolean {
  const current = captureClaudeResponseLimitFailure(thread, selectedInstanceId);
  return (
    current !== null &&
    current.environmentId === expected.environmentId &&
    current.threadId === expected.threadId &&
    current.instanceId === expected.instanceId &&
    current.turnId === expected.turnId &&
    current.completedAt === expected.completedAt &&
    current.sessionCreatedAt === expected.sessionCreatedAt &&
    current.sessionUpdatedAt === expected.sessionUpdatedAt &&
    current.runtimeId === expected.runtimeId
  );
}

/** Preserve even whitespace, pending uploads, restored images and parked queue edits. */
export function isClaudeContinuationDraftEmpty(
  draft: ComposerThreadDraftState | null | undefined,
): boolean {
  return (
    !draft ||
    (draft.prompt.length === 0 &&
      draft.images.length === 0 &&
      draft.files.length === 0 &&
      draft.nonPersistedImageIds.length === 0 &&
      draft.persistedAttachments.length === 0 &&
      draft.queueEditingItemId === undefined)
  );
}
