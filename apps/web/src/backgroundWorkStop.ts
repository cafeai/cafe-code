import type { OrchestrationLiveWork } from "@cafecode/contracts";
import { deriveLiveWorkObservations, isLiveWorkRuntimeCurrent } from "@cafecode/shared/liveWork";
import type { Thread } from "./types";

type BackgroundWorkThread = Pick<
  Thread,
  "id" | "environmentId" | "session" | "archivedAt" | "latestTurn" | "activities"
>;

/** Offer the existing whole-chat Stop after a root ends. Liveness only makes
 * that human action visible; it cannot mint an individual task capability. */
export function backgroundWorkStopOwner(
  thread: BackgroundWorkThread | undefined,
  liveWork?: OrchestrationLiveWork,
) {
  const session = thread?.session;
  if (
    !thread ||
    thread.archivedAt !== null ||
    session?.status !== "ready" ||
    session.activeTurnId !== undefined ||
    !session.providerInstanceId ||
    !session.subagentRuntimeId ||
    !isLiveWorkRuntimeCurrent(session.subagentRuntimeId, session) ||
    thread.latestTurn?.state === "running"
  )
    return null;
  const summary = isLiveWorkRuntimeCurrent(liveWork?.runtimeId, session) ? liveWork : undefined;
  const hasWork = summary
    ? summary.taskCount > 0 || summary.agentCount > 0
    : deriveLiveWorkObservations(thread.activities, session).length > 0;
  if (!hasWork) return null;
  return {
    threadId: thread.id,
    environmentId: thread.environmentId,
    provider: session.provider,
    providerInstanceId: session.providerInstanceId,
    runtimeId: session.subagentRuntimeId,
    turnId: thread.latestTurn?.turnId ?? null,
  };
}

/** Recheck synchronously at the click boundary. The durable session Stop is
 * still a whole-chat command, not a native generation compare-and-swap. */
export function backgroundWorkStopCommand(
  owner: NonNullable<ReturnType<typeof backgroundWorkStopOwner>>,
  thread: BackgroundWorkThread | undefined,
  liveWork?: OrchestrationLiveWork,
): "session-stop" | null {
  const current = backgroundWorkStopOwner(thread, liveWork);
  return current &&
    current.threadId === owner.threadId &&
    current.environmentId === owner.environmentId &&
    current.provider === owner.provider &&
    current.providerInstanceId === owner.providerInstanceId &&
    current.runtimeId === owner.runtimeId &&
    current.turnId === owner.turnId
    ? "session-stop"
    : null;
}
