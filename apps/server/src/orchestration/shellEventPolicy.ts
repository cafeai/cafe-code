import type { OrchestrationEvent } from "@cafecode/contracts";
import { readLiveWorkObservation } from "@cafecode/shared/liveWork";

/**
 * Both subscription stages must forward the same shell-affecting events.
 * Native work observations include inactive retractions: checking only active
 * work would leave completed/backgrounded children visible indefinitely. This
 * is refresh admission, not liveness authority; the current projection still
 * owns runtime/turn binding and the resulting counts.
 */
export function doesOrchestrationEventAffectShell(event: OrchestrationEvent): boolean {
  if (event.type !== "thread.activity-appended") return true;
  if (readLiveWorkObservation(event.payload.activity) !== null) return true;
  switch (event.payload.activity.kind) {
    case "approval.requested":
    case "approval.resolved":
    case "provider.approval.respond.failed":
    case "user-input.requested":
    case "user-input.resolved":
    case "provider.user-input.respond.failed":
      return true;
    default:
      return false;
  }
}
