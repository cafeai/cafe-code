import { describe, expect, it } from "vitest";

import { deriveDebugWaitReasons } from "./debugWaitReasons";

describe("deriveDebugWaitReasons", () => {
  it("explains long-running provider tool work and pruning pressure", () => {
    expect(
      deriveDebugWaitReasons({
        lifecycle: {
          phase: "running",
          streamingMessageCount: 0,
          latestActiveTurnActivity: {
            kind: "tool.started",
          },
        },
        performance: {
          pressureFlags: ["message-window-at-server-limit", "large-context-input-token-count"],
          latency: {
            lastActivityAgeMs: 120_000,
          },
        },
        activeQueueLength: 1,
        activeSteeringFollowUpCount: 1,
        followUpQueueVisibleWorking: true,
        followUpQueueDispatchInFlight: false,
        activeTurnInProgress: true,
      }),
    ).toEqual([
      "provider-running-tool",
      "provider-awaiting-terminal-event",
      "steer-accepted-waiting-for-provider",
      "queue-blocked-by-active-turn",
      "large-context",
      "debug-pruned",
    ]);
  });

  it("does not report queue bugs when the queue is empty and the provider is simply idle", () => {
    expect(
      deriveDebugWaitReasons({
        lifecycle: {
          phase: "ready",
          streamingMessageCount: 0,
          latestActiveTurnActivity: {
            kind: "tool.completed",
          },
        },
        performance: {
          pressureFlags: [],
          latency: {
            lastActivityAgeMs: 5_000,
          },
        },
        activeQueueLength: 0,
        activeSteeringFollowUpCount: 0,
        followUpQueueVisibleWorking: false,
        followUpQueueDispatchInFlight: false,
        activeTurnInProgress: false,
      }),
    ).toEqual([]);
  });

  it("does not report provider tool work after the turn has settled", () => {
    expect(
      deriveDebugWaitReasons({
        lifecycle: {
          phase: "ready",
          streamingMessageCount: 0,
          latestActiveTurnActivity: {
            kind: "task.progress",
          },
        },
        performance: {
          pressureFlags: ["large-context-input-token-count"],
          latency: {
            lastActivityAgeMs: 5_000,
          },
        },
        activeQueueLength: 0,
        activeSteeringFollowUpCount: 0,
        followUpQueueVisibleWorking: false,
        followUpQueueDispatchInFlight: false,
        activeTurnInProgress: false,
      }),
    ).toEqual(["large-context"]);
  });

  it("keeps provider tool work visible while orchestration still owns an active turn", () => {
    expect(
      deriveDebugWaitReasons({
        lifecycle: {
          phase: "ready",
          streamingMessageCount: 0,
          latestActiveTurnActivity: {
            kind: "task.progress",
          },
        },
        performance: {
          pressureFlags: [],
          latency: {
            lastActivityAgeMs: 5_000,
          },
        },
        activeQueueLength: 0,
        activeSteeringFollowUpCount: 0,
        followUpQueueVisibleWorking: false,
        followUpQueueDispatchInFlight: false,
        activeTurnInProgress: true,
      }),
    ).toEqual(["provider-running-tool"]);
  });

  it("deduplicates overlapping running states", () => {
    expect(
      deriveDebugWaitReasons({
        lifecycle: {
          phase: "running",
          streamingMessageCount: 3,
          latestActiveTurnActivity: {
            kind: "tool.updated",
          },
        },
        performance: {
          pressureFlags: ["large-activity-payload-window", "large-activity-payload-window"],
          latency: {
            lastActivityAgeMs: 10_000,
          },
        },
        activeQueueLength: 0,
        activeSteeringFollowUpCount: 0,
        followUpQueueVisibleWorking: true,
        followUpQueueDispatchInFlight: true,
        activeTurnInProgress: true,
      }),
    ).toEqual([
      "provider-running-tool",
      "provider-streaming",
      "debug-pruned",
      "queue-dispatch-in-flight",
    ]);
  });
});
