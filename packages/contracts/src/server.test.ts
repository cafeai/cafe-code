import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { ServerProvider, ServerRuntimeLayerDiagnosticsResult } from "./server.ts";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);
const decodeRuntimeLayerDiagnostics = Schema.decodeUnknownSync(ServerRuntimeLayerDiagnosticsResult);

describe("ServerProvider", () => {
  it("defaults capability arrays when decoding provider snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.slashCommands).toEqual([]);
    expect(parsed.skills).toEqual([]);
    expect(parsed.versionAdvisory).toBeUndefined();
    expect(parsed.updateState).toBeUndefined();
  });

  it("defaults one-click update support when decoding older advisory snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
      versionAdvisory: {
        status: "behind_latest",
        currentVersion: "1.0.0",
        latestVersion: "1.0.1",
        updateCommand: "npm install -g @openai/codex@latest",
        checkedAt: "2026-04-10T00:00:00.000Z",
        message: "Update available.",
      },
    });

    expect(parsed.versionAdvisory?.canUpdate).toBe(false);
  });

  it("decodes continuation group metadata", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex_personal",
      driver: "codex",
      continuation: { groupKey: "codex:home:/Users/julius/.codex" },
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.continuation?.groupKey).toBe("codex:home:/Users/julius/.codex");
  });

  it("decodes optional Codex account rate limit snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
        type: "chatgpt",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
      accountRateLimits: {
        checkedAt: "2026-04-10T00:00:00.000Z",
        rateLimits: {
          limitId: "codex",
          planType: "pro",
          primary: {
            usedPercent: 42.5,
            windowDurationMins: 300,
            resetsAt: 1_780_000_000,
          },
          secondary: {
            usedPercent: 84,
            windowDurationMins: 10_080,
            resetsAt: 1_780_100_000,
          },
        },
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            primary: {
              usedPercent: 42.5,
            },
          },
        },
      },
    });

    expect(parsed.accountRateLimits?.rateLimits.primary?.windowDurationMins).toBe(300);
    expect(parsed.accountRateLimits?.rateLimitsByLimitId?.codex?.primary?.usedPercent).toBe(42.5);
  });

  it("decodes lightweight runtime layer diagnostics", () => {
    const parsed = decodeRuntimeLayerDiagnostics({
      readAt: "2026-05-26T00:00:00.000Z",
      platform: "darwin",
      windowMs: 300_000,
      bucketMs: 30_000,
      collectionSource: "server-runtime",
      partialFailure: false,
      runtimeLayers: [
        {
          role: "backend",
          status: "online",
          pid: 100,
          rssBytes: 1024,
          cpuPercent: 1.5,
          uptimeLabel: "00:10",
          lastEventAt: "2026-05-26T00:00:00.000Z",
          notes: ["Main backend process."],
        },
      ],
      orchestrator: {
        latestEventSequence: 10,
        projectionSequence: 8,
        projectionLag: 2,
        commandQueueDepth: 1,
        acceptedCommandCount: 4,
        rejectedCommandCount: 0,
        failedCommandCount: 1,
        projectCount: 2,
        threadCount: 3,
        pendingTurnCount: 0,
        runningTurnCount: 1,
        activeTurnCount: 1,
        recentEventTypeCounts: [
          {
            eventType: "thread.message-sent",
            actorKind: "provider",
            count: 2,
            lastSeenAt: "2026-05-26T00:00:00.000Z",
          },
        ],
        projectorCursors: [
          {
            projector: "thread-detail",
            cursor: 8,
            lag: 2,
            updatedAt: "2026-05-26T00:00:00.000Z",
            status: "degraded",
          },
        ],
        staleStateFlags: [
          {
            kind: "terminal-streaming-message",
            count: 1,
            severity: "warning",
            message: "Assistant messages are still marked streaming.",
          },
        ],
      },
      subprocesses: [
        {
          role: "provider-daemon",
          ownerKind: "daemon-marker",
          pid: 300,
          ppid: 1,
          status: "S",
          cpuPercent: 2,
          rssBytes: 2048,
          elapsed: "00:05",
          commandLabel: "node",
          sanitizedCommand: "node daemon.mjs",
          depth: 0,
          childPids: [],
          attribution: "daemon health PID",
          lastSeenAt: "2026-05-26T00:00:00.000Z",
          notes: [],
        },
      ],
      providerDaemon: {
        available: true,
        reachable: true,
        status: "online",
        pid: 300,
        ppid: 1,
        mode: "provider-daemon",
        transport: "loopback-tcp",
        healthLatencyMs: 4,
        startedAt: "2026-05-26T00:00:00.000Z",
        activeSessionCount: 1,
        activeStreamCount: 0,
        retainedEventCount: 5,
        eventCursor: 11,
        leaseCount: 1,
        commandCount: 3,
        runningCommandCount: 0,
        completedCommandCount: 3,
        failedCommandCount: 0,
        totalRpcCount: 6,
        failedRpcCount: 0,
        maxRpcDurationMs: 12,
        meanRpcDurationMs: 3,
        sqliteBusyTimeoutMs: 5000,
        recentCommands: [
          {
            status: "completed",
            method: "sendTurn",
            durationMs: 11,
            updatedAt: "2026-05-26T00:00:00.000Z",
            error: null,
          },
        ],
        runtimeEventSummaries: [
          {
            eventType: "provider.delta",
            count: 4,
            lastSeenAt: "2026-05-26T00:00:00.000Z",
          },
        ],
        error: null,
      },
      providerSupervisor: {
        configured: true,
        reachable: false,
        status: "degraded",
        pid: null,
        ppid: null,
        transport: null,
        healthLatencyMs: null,
        activeSessionCount: 0,
        activeStreamCount: 0,
        retainedEventCount: 0,
        commandCount: 0,
        runningCommandCount: 0,
        completedCommandCount: 0,
        failedCommandCount: 0,
        sessionCounts: {
          unavailable: 1,
        },
        error: "Provider supervisor is unavailable.",
      },
      resources: {
        sampleIntervalMs: 0,
        retainedSampleCount: 1,
        buckets: [
          {
            role: "provider-daemon",
            startedAt: "2026-05-26T00:00:00.000Z",
            endedAt: "2026-05-26T00:00:30.000Z",
            maxRssBytes: 2048,
            maxCpuPercent: 2,
            sampleCount: 1,
          },
        ],
        processes: [
          {
            processKey: "provider-daemon:300:node",
            role: "provider-daemon",
            pid: 300,
            currentRssBytes: 2048,
            maxRssBytes: 2048,
            currentCpuPercent: 2,
            avgCpuPercent: 2,
            maxCpuPercent: 2,
            sampleCount: 1,
            lastSeenAt: "2026-05-26T00:00:00.000Z",
          },
        ],
      },
      errors: [],
    });

    expect(parsed.orchestrator.projectionLag).toBe(2);
    expect(parsed.providerDaemon.reachable).toBe(true);
  });

  it("rejects malformed runtime layer diagnostics", () => {
    expect(() =>
      decodeRuntimeLayerDiagnostics({
        readAt: "2026-05-26T00:00:00.000Z",
        platform: "darwin",
        windowMs: 0,
        bucketMs: 0,
        collectionSource: "server-runtime",
        partialFailure: true,
        runtimeLayers: [],
        orchestrator: {
          latestEventSequence: 0,
          projectionSequence: 0,
          projectionLag: 0,
          commandQueueDepth: 0,
          acceptedCommandCount: 0,
          rejectedCommandCount: 0,
          failedCommandCount: 0,
          projectCount: 0,
          threadCount: 0,
          pendingTurnCount: 0,
          runningTurnCount: 0,
          activeTurnCount: 0,
          recentEventTypeCounts: [],
          projectorCursors: [],
          staleStateFlags: [],
        },
        subprocesses: [],
        providerDaemon: {
          available: false,
          reachable: false,
          status: "offline",
          pid: null,
          ppid: null,
          mode: null,
          transport: null,
          healthLatencyMs: null,
          startedAt: null,
          activeSessionCount: 0,
          activeStreamCount: 0,
          retainedEventCount: 0,
          eventCursor: 0,
          leaseCount: 0,
          commandCount: 0,
          runningCommandCount: 0,
          completedCommandCount: 0,
          failedCommandCount: 0,
          totalRpcCount: 0,
          failedRpcCount: 0,
          maxRpcDurationMs: 0,
          meanRpcDurationMs: null,
          sqliteBusyTimeoutMs: null,
          recentCommands: [],
          runtimeEventSummaries: [],
          error: null,
        },
        providerSupervisor: {
          configured: false,
          reachable: false,
          status: "offline",
          pid: null,
          ppid: null,
          transport: null,
          healthLatencyMs: null,
          activeSessionCount: 0,
          activeStreamCount: 0,
          retainedEventCount: 0,
          commandCount: 0,
          runningCommandCount: 0,
          completedCommandCount: 0,
          failedCommandCount: 0,
          sessionCounts: {},
          error: null,
        },
        resources: {
          sampleIntervalMs: 0,
          retainedSampleCount: 0,
          buckets: [],
          processes: [],
        },
        errors: [{ source: "", message: "bad" }],
      }),
    ).toThrow();
  });
});
