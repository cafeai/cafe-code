import * as NodeOs from "node:os";

export const PROVIDER_DAEMON_PRIORITY = NodeOs.constants.priority.PRIORITY_BELOW_NORMAL;

export interface ProviderDaemonPriorityOperations {
  readonly getPriority: () => number;
  readonly setPriority: (pid: number, priority: number) => void;
}

/** Apply before provider runtime construction so ordinary descendants inherit it. */
export function lowerProviderDaemonPriority(
  operations: ProviderDaemonPriorityOperations = NodeOs,
): "lowered" | "already-lower" | "unavailable" {
  try {
    // Larger nice values mean lower scheduling priority. Preserve a process
    // that its launcher has already assigned an even lower priority.
    if (operations.getPriority() >= PROVIDER_DAEMON_PRIORITY) return "already-lower";
    operations.setPriority(0, PROVIDER_DAEMON_PRIORITY);
    return "lowered";
  } catch {
    // Scheduling policy is best effort and cannot become a provider outage.
    return "unavailable";
  }
}
