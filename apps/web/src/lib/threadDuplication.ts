import type { ClientOrchestrationCommand, ScopedThreadRef } from "@cafecode/contracts";
import { isLiveWorkRuntimeCurrent } from "@cafecode/shared/liveWork";

import { isLatestTurnSettled } from "../session-logic";
import type { SidebarThreadSummary, Thread } from "../types";
import { newCommandId, newThreadId } from "./utils";

type DuplicationSource = Pick<
  SidebarThreadSummary,
  "id" | "environmentId" | "archivedAt" | "session" | "latestTurn"
> &
  Partial<
    Pick<SidebarThreadSummary, "hasPendingApprovals" | "hasPendingUserInput" | "liveWork">
  > & {
    readonly deletedAt?: string | null | undefined;
    readonly modelSelection?: Thread["modelSelection"] | undefined;
  };

/** UI admission only: the native provider and server remain authoritative for
 * whole-tree idleness, account/history identity and the copied snapshot. Shell
 * summaries can contribute current background-work/approval observations without
 * subscribing to, scanning or retaining the conversation's message history.
 */
export function canDuplicateThread(source: DuplicationSource | null | undefined): boolean {
  if (!source || source.archivedAt !== null || source.deletedAt != null) return false;
  const session = source.session;
  if (
    !session ||
    (session.provider !== "codex" && session.provider !== "claudeAgent") ||
    session.status === "running" ||
    session.status === "connecting" ||
    session.orchestrationStatus === "starting" ||
    session.orchestrationStatus === "running" ||
    session.activeTurnId != null ||
    source.latestTurn?.state === "running" ||
    source.hasPendingApprovals === true ||
    source.hasPendingUserInput === true ||
    !isLatestTurnSettled(source.latestTurn, session)
  )
    return false;
  if (
    source.modelSelection &&
    session.providerInstanceId !== undefined &&
    source.modelSelection.instanceId !== session.providerInstanceId
  )
    return false;
  return !(
    source.liveWork &&
    isLiveWorkRuntimeCurrent(source.liveWork.runtimeId, session) &&
    source.liveWork.taskCount + source.liveWork.agentCount > 0
  );
}

type ForkCommand = Extract<ClientOrchestrationCommand, { readonly type: "thread.fork" }>;
type Scalar = string | number | boolean | null | undefined;
type Operation = {
  readonly fingerprint: string;
  readonly command: ForkCommand;
  owner: symbol | null;
};

// These are user gestures, not a retry queue. A missing acknowledgement can
// mean that the native fork already exists. Keep its exact command/target for
// an explicit same-source retry instead of silently creating another branch.
// Never evict an uncertain record to make room: capacity refusal is safer than
// discarding the only local identity for a potentially committed mutation.
const MAX_OPERATIONS = 128;
const MAX_SCALAR_LENGTH = 4096;
const MAX_FINGERPRINT_LENGTH = 16_384;
const operations = new Map<string, Operation>();

function sourceKey(ref: ScopedThreadRef): string | null {
  if (
    typeof ref.environmentId !== "string" ||
    typeof ref.threadId !== "string" ||
    !ref.environmentId ||
    !ref.threadId ||
    ref.environmentId.length > MAX_SCALAR_LENGTH ||
    ref.threadId.length > MAX_SCALAR_LENGTH
  )
    return null;
  return JSON.stringify([ref.environmentId, ref.threadId]);
}

/** Bounded scalar stale-gesture fencing, not a cryptographic source-version
 * proof. The server binds the actual durable source/project event revision.
 * Deliberately retain no Thread, messages, activities, callback or provider
 * object. Unknown and explicit null policy values remain distinguishable.
 */
function sourceFingerprint(source: Thread): string | null {
  const session = source.session;
  const turn = source.latestTurn;
  const options = source.modelSelection.options;
  if (options && options.length > 64) return null;
  const values: Scalar[] = [
    source.environmentId,
    source.id,
    source.createdAt,
    source.updatedAt,
    source.title,
    source.projectId,
    source.branch,
    source.worktreePath,
    source.codexThreadId,
    source.runtimeMode,
    source.interactionMode,
    source.modelSelection.instanceId,
    source.modelSelection.model,
    options !== undefined,
    source.subagentLimits !== undefined,
    source.subagentLimits?.codex,
    source.subagentLimits?.claude,
    source.codexContextWindowOverride,
    session?.provider,
    session?.providerInstanceId,
    session?.status,
    session?.orchestrationStatus,
    session?.createdAt,
    session?.updatedAt,
    session?.subagentRuntimeId,
    session?.activeTurnId,
    session?.maxConcurrentSubagents,
    session?.codexContextWindowOverride,
    session?.codexAutoCompactTokenLimit,
    turn?.turnId,
    turn?.state,
    turn?.requestedAt,
    turn?.startedAt,
    turn?.completedAt,
    turn?.assistantMessageId,
  ];
  for (const option of options ?? []) values.push(option.id, option.value);
  if (
    values.some(
      (value) =>
        (typeof value === "string" && value.length > MAX_SCALAR_LENGTH) ||
        (typeof value === "number" && !Number.isFinite(value)),
    )
  )
    return null;
  const fingerprint = JSON.stringify(
    values.map((value) => (value === undefined ? ["missing"] : ["present", value])),
  );
  return fingerprint.length <= MAX_FINGERPRINT_LENGTH ? fingerprint : null;
}

export function isThreadDuplicationPending(ref: ScopedThreadRef): boolean {
  const key = sourceKey(ref);
  return key !== null && operations.get(key)?.owner != null;
}

/** Reserve a single native-copy operation across all mounted menu/hook
 * instances. A retired caller cannot finish a successor's reservation. Success
 * permits a later deliberate second copy; uncertainty permits only an exact
 * same-source retry and never automatically submits anything.
 */
export function claimThreadDuplication(
  source: Thread,
  title: string,
): {
  readonly command: ForkCommand;
  readonly finish: (outcome: "acknowledged" | "uncertain") => void;
} | null {
  if (!canDuplicateThread(source) || !title.trim() || title.length > 512) return null;
  const key = sourceKey({ environmentId: source.environmentId, threadId: source.id });
  const fingerprint = sourceFingerprint(source);
  if (key === null || fingerprint === null) return null;
  let operation = operations.get(key);
  if (operation) {
    if (operation.owner !== null || operation.fingerprint !== fingerprint) return null;
  } else {
    if (operations.size >= MAX_OPERATIONS) return null;
    operation = {
      fingerprint,
      command: Object.freeze({
        type: "thread.fork",
        commandId: newCommandId(),
        sourceThreadId: source.id,
        targetThreadId: newThreadId(),
        title,
        createdAt: new Date().toISOString(),
      }),
      owner: null,
    };
    operations.set(key, operation);
  }
  const ownedOperation = operation;
  const owner = Symbol("thread-duplication");
  ownedOperation.owner = owner;
  return {
    command: ownedOperation.command,
    finish: (outcome) => {
      if (operations.get(key) !== ownedOperation || ownedOperation.owner !== owner) return;
      if (outcome === "acknowledged") operations.delete(key);
      else ownedOperation.owner = null;
    },
  };
}
