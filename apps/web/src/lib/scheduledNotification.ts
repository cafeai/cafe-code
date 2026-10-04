import type { EnvironmentApi, ThreadId, TurnId } from "@cafecode/contracts";

/** Query durable run provenance before ordinary completion notifications. A
 * prompt asking the model to stay quiet does not silence a native notification.
 * Failed policy reads are inconclusive, so suppress rather than spam quiet
 * schedules. Backends without the namespace retain their pre-feature behavior. */
export async function shouldNotifyScheduledTurn(
  api: EnvironmentApi | undefined,
  threadId: ThreadId,
  turnId: TurnId | null,
): Promise<boolean> {
  if (!api) return false;
  if (!api.scheduledFollowups) return true;
  try {
    return (await api.scheduledFollowups.notification({ threadId, turnId })).notify;
  } catch {
    return false;
  }
}
