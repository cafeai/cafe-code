export interface DebugWaitReasonLifecycleSummary {
  readonly phase?: string | null;
  readonly streamingMessageCount?: number | null;
  readonly latestActiveTurnActivity?: {
    readonly kind?: string | null;
  } | null;
}

export interface DebugWaitReasonPerformanceSummary {
  readonly pressureFlags?: readonly string[] | null;
  readonly latency?: {
    readonly lastActivityAgeMs?: number | null;
  } | null;
}

export interface DebugWaitReasonInput {
  readonly lifecycle: DebugWaitReasonLifecycleSummary | null;
  readonly performance: DebugWaitReasonPerformanceSummary | null;
  readonly activeQueueLength: number;
  readonly activeSteeringFollowUpCount: number;
  readonly followUpQueueVisibleWorking: boolean;
  readonly followUpQueueDispatchInFlight: boolean;
  readonly activeTurnInProgress: boolean;
}

const ACTIVE_TOOL_ACTIVITY_KINDS = new Set([
  "tool.started",
  "tool.updated",
  "task.started",
  "task.progress",
]);

const DEBUG_PRUNED_PRESSURE_FLAGS = new Set([
  "message-window-at-server-limit",
  "activity-window-at-server-limit",
  "large-message-text-window",
  "large-activity-payload-window",
]);

export function deriveDebugWaitReasons(input: DebugWaitReasonInput): readonly string[] {
  const latestActivityKind = input.lifecycle?.latestActiveTurnActivity?.kind ?? null;
  const lifecyclePhase = input.lifecycle?.phase ?? null;
  const providerTurnIsRunning = lifecyclePhase === "running" || input.activeTurnInProgress;
  const pressureFlags = input.performance?.pressureFlags ?? [];
  const lastActivityAgeMs = input.performance?.latency?.lastActivityAgeMs ?? null;
  const reasons = [
    providerTurnIsRunning &&
    latestActivityKind !== null &&
    ACTIVE_TOOL_ACTIVITY_KINDS.has(latestActivityKind)
      ? "provider-running-tool"
      : null,
    lifecyclePhase === "running" && (input.lifecycle?.streamingMessageCount ?? 0) > 0
      ? "provider-streaming"
      : null,
    lifecyclePhase === "running" && lastActivityAgeMs !== null && lastActivityAgeMs >= 60_000
      ? "provider-awaiting-terminal-event"
      : null,
    input.activeSteeringFollowUpCount > 0 && input.followUpQueueVisibleWorking
      ? "steer-accepted-waiting-for-provider"
      : null,
    input.activeQueueLength > 0 && input.activeTurnInProgress
      ? "queue-blocked-by-active-turn"
      : null,
    pressureFlags.includes("large-context-input-token-count") ? "large-context" : null,
    pressureFlags.some((flag) => DEBUG_PRUNED_PRESSURE_FLAGS.has(flag)) ? "debug-pruned" : null,
    input.followUpQueueDispatchInFlight ? "queue-dispatch-in-flight" : null,
  ].filter((reason): reason is string => reason !== null);

  return Array.from(new Set(reasons));
}
