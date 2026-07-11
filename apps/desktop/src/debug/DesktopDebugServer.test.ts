// @effect-diagnostics globalDate:off
import { assert, describe, it } from "@effect/vitest";

import { __desktopDebugServerTestApi as debugServer } from "./DesktopDebugServer.ts";

const makeLargeRendererSnapshot = (index: number) => ({
  debugSnapshotVersion: 50,
  source: "test",
  capturedAt: new Date(1_700_000_000_000 + index).toISOString(),
  route: {
    activeThreadId: "thread-1",
  },
  project: {
    id: "project-1",
    name: "project",
    cwd: "/Users/mike/secret/project",
  },
  thread: {
    id: "thread-1",
    title: "Long debug thread",
    projectId: "project-1",
    worktreePath: "/Users/mike/secret/project",
    messageCount: 2_000,
    activityCount: 500,
    session: {
      status: "running",
      activeTurnId: "turn-1",
      provider: "codex",
    },
    latestTurn: {
      turnId: "turn-1",
      state: "running",
      requestedAt: "2026-05-26T00:00:00.000Z",
      startedAt: "2026-05-26T00:00:01.000Z",
      completedAt: null,
    },
    recentMessages: [
      {
        id: "message-1",
        role: "user",
        textPreview: `prompt-secret-${index}`.repeat(1_000),
      },
    ],
    recentActivities: [
      {
        id: "activity-1",
        kind: "runtime.warning",
        summaryPreview: `output-secret-${index}`.repeat(1_000),
        payloadPreview: JSON.stringify({ token: `npm_${"A".repeat(40)}` }),
      },
    ],
  },
  performance: {
    rendererSnapshotBuildDurationMs: 12,
    activeThread: {
      pressureFlags: [
        "message-window-at-server-limit",
        "activity-window-at-server-limit",
        "large-context-input-token-count",
      ],
      approximateChars: {
        messageText: 2_000_000,
        activityPayloadJson: 2_000_000,
      },
      latency: {
        activeTurnElapsedMs: 3_600_000,
        lastActivityAgeMs: 120_000,
      },
      latestMessage: {
        textPreview: `assistant-secret-${index}`.repeat(1_000),
      },
    },
    storePressure: {
      threadCount: 1,
      maxThreadMessageCount: 2_000,
      maxThreadActivityCount: 500,
    },
    notableThreads: Array.from({ length: 30 }, (_, threadIndex) => ({
      id: `notable-${threadIndex}`,
      title: `Notable ${threadIndex}`,
      latestActiveTurnMessage: {
        textPreview: `notable-secret-${threadIndex}`.repeat(100),
      },
    })),
  },
  lifecycle: {
    active: {
      phase: "running",
      latestActiveTurnActivity: {
        kind: "tool.started",
        summaryPreview: "tool command should be omitted",
      },
      redFlags: ["provider-signal-after-earliest-completion-signal"],
    },
    counts: {
      sessionsRunning: 1,
    },
    queueCoupling: {
      activeQueueLength: 1,
      waitReasons: ["provider-running-tool", "debug-pruned"],
      redFlags: ["queue-blocked-by-active-turn"],
    },
    interestingThreads: Array.from({ length: 30 }, (_, threadIndex) => ({
      id: `interesting-${threadIndex}`,
      latestActiveTurnMessage: {
        textPreview: `interesting-secret-${threadIndex}`.repeat(100),
      },
    })),
  },
  queue: {
    activeThreadId: "thread-1",
    length: 1,
    steeringLength: 0,
    blockers: ["thread-visible-working"],
    items: [
      {
        id: "queue-1",
        promptPreview: "queued prompt should be omitted".repeat(100),
        promptLength: 3_000,
      },
    ],
    allQueues: {
      "thread-1": {
        items: [
          {
            promptPreview: "queued allQueues prompt should be omitted".repeat(100),
          },
        ],
      },
    },
  },
  gates: {
    waitReasons: ["provider-running-tool", "debug-pruned"],
  },
});

const makeLargeProviderDaemonSnapshot = () => ({
  status: "running",
  pid: 123,
  endpoint: {
    httpBaseUrl: "http://127.0.0.1:3773",
    transport: "ipc",
    socketPath: "/Users/mike/.cafe-code/provider-daemon.sock",
    leaseId: "lease-secret",
  },
  markerPath: "/Users/mike/.cafe-code/provider-daemon-marker.json",
  credentialPath: "/Users/mike/.cafe-code/provider-daemon-token.bin",
  lastHealth: {
    ok: true,
    mode: "provider-daemon",
    pid: 123,
    activeStreamCount: 1,
    retainedEventCount: 760_000,
    eventCursor: 970_000,
    commandCount: 465,
    completedCommandCount: 449,
    failedCommandCount: 16,
    runningCommandCount: 0,
    recentCompletedCommands: Array.from({ length: 50 }, (_, index) => ({
      id: `command-${index}`,
      payload: `command-secret-${index}`.repeat(500),
    })),
    rpc: {
      totalRpcCount: 100,
      mutatingRpcCount: 40,
      failedRpcCount: 2,
      recentFailures: Array.from({ length: 20 }, (_, index) => ({
        message: `failure-secret-${index}`.repeat(100),
      })),
    },
    runtimeEvents: {
      recentMethodCounts: Array.from({ length: 50 }, (_, index) => ({
        method: `method-${index}`,
        count: index,
      })),
      recentTurnTimings: Array.from({ length: 50 }, (_, index) => ({
        turnId: `turn-${index}`,
      })),
      lastEventAt: "2026-05-26T00:00:00.000Z",
      lastThreadId: "thread-1",
      lastTurnId: "turn-1",
    },
    supervisor: {
      sessionCount: 5,
      runningSessionCount: 1,
      errorSessionCount: 0,
    },
  },
});

describe("DesktopDebugServer compact snapshots", () => {
  it("keeps default debug bounded and strips long-running prompt/output previews", () => {
    debugServer.reset();
    for (let index = 0; index < 25; index += 1) {
      debugServer.publishRendererSnapshot(makeLargeRendererSnapshot(index));
    }
    debugServer.publishProviderDaemonSnapshot(makeLargeProviderDaemonSnapshot());

    const compact = debugServer.buildCompactDebugSnapshot();
    const compactJson = JSON.stringify(compact);

    assert.equal((compact.debug as Record<string, unknown>).detail, "compact");
    assert.equal(debugServer.rendererHistoryLength(), 20);
    assert.equal(compactJson.includes("prompt-secret"), false);
    assert.equal(compactJson.includes("assistant-secret"), false);
    assert.equal(compactJson.includes("queued prompt should be omitted"), false);
    assert.equal(compactJson.includes("command-secret"), false);
    assert.equal(compactJson.includes("provider-running-tool"), true);
    assert.equal(compactJson.includes("debug-pruned"), true);
    assert.ok(Buffer.byteLength(compactJson, "utf8") < 80_000);
  });

  it("keeps full debug explicit for local forensic reads", () => {
    debugServer.reset();
    debugServer.publishRendererSnapshot(makeLargeRendererSnapshot(1));
    debugServer.publishProviderDaemonSnapshot(makeLargeProviderDaemonSnapshot());

    const full = debugServer.buildFullDebugSnapshot();
    const fullJson = JSON.stringify(full);

    assert.equal((full.debug as Record<string, unknown>).detail, "full");
    assert.equal(fullJson.includes("prompt-secret-1"), true);
    assert.equal(fullJson.includes("command-secret-1"), true);
  });

  it("reports provider-to-renderer freshness lag without reading content previews", () => {
    debugServer.reset();
    debugServer.publishRendererSnapshot({
      ...makeLargeRendererSnapshot(1),
      performance: {
        rendererSnapshotBuildDurationMs: 12,
        activeThread: {
          latestMessage: {
            createdAt: "2026-05-26T00:00:00.000Z",
            textPreview: "hidden assistant text",
          },
        },
      },
    });
    debugServer.publishProviderDaemonSnapshot({
      ...makeLargeProviderDaemonSnapshot(),
      lastHealth: {
        ...makeLargeProviderDaemonSnapshot().lastHealth,
        runtimeEvents: {
          lastEventAt: "2026-05-26T00:03:00.000Z",
          lastThreadId: "thread-1",
          lastTurnId: "turn-1",
        },
      },
    });

    const compact = debugServer.buildCompactDebugSnapshot();
    const freshness = compact.freshness as Record<string, unknown>;

    assert.equal(freshness.status, "offline");
    assert.equal(freshness.activeThreadId, "thread-1");
    assert.equal(freshness.providerLastThreadId, "thread-1");
    assert.equal(freshness.lagMs, 179_000);
    assert.equal(JSON.stringify(freshness).includes("hidden assistant text"), false);
  });

  it("uses cached provider daemon snapshots for ordinary debug reads", async () => {
    debugServer.reset();
    debugServer.publishProviderDaemonSnapshot(makeLargeProviderDaemonSnapshot());
    debugServer.setProviderDaemonSnapshotUpdatedAt("9999-01-01T00:00:00.000Z");
    let refreshCount = 0;
    debugServer.setProviderDaemonSnapshotRefresher(async () => {
      refreshCount += 1;
      debugServer.publishProviderDaemonSnapshot(makeLargeProviderDaemonSnapshot());
    });

    await debugServer.prepareProviderDaemonSnapshotForDebugRequest(false);
    assert.equal(refreshCount, 0);
    assert.equal(debugServer.getProviderDaemonRefreshAttemptCount(), 0);

    await debugServer.prepareProviderDaemonSnapshotForDebugRequest(true);
    assert.equal(refreshCount, 1);
    assert.equal(debugServer.getProviderDaemonRefreshAttemptCount(), 1);

    let resolveBackgroundRefresh!: () => void;
    const backgroundRefreshCompleted = new Promise<void>((resolve) => {
      resolveBackgroundRefresh = resolve;
    });
    debugServer.setProviderDaemonSnapshotRefresher(async () => {
      refreshCount += 1;
      debugServer.publishProviderDaemonSnapshot(makeLargeProviderDaemonSnapshot());
      resolveBackgroundRefresh();
    });
    debugServer.setProviderDaemonSnapshotUpdatedAt("1970-01-01T00:00:00.000Z");
    await debugServer.prepareProviderDaemonSnapshotForDebugRequest(false);
    await backgroundRefreshCompleted;

    assert.equal(refreshCount, 2);
    assert.equal(debugServer.getProviderDaemonRefreshAttemptCount(), 2);
  });
});
