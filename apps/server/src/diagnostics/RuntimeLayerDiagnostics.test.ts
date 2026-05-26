import { describe, expect, it } from "@effect/vitest";
import type { ProviderDaemonHealth } from "@cafecode/contracts";

import {
  buildLayerSummaries,
  buildProjectorCursors,
  buildRuntimeProcessEntries,
  buildStaleStateFlags,
  mapProviderDaemonHealth,
  mapProviderSupervisorHealth,
  sanitizeProcessCommand,
} from "./RuntimeLayerDiagnostics.ts";

const readAt = "2026-05-26T00:00:00.000Z";

describe("RuntimeLayerDiagnostics", () => {
  it("redacts tokens and credential paths from command strings", () => {
    const sanitized = sanitizeProcessCommand(
      [
        "node dist/bin.mjs",
        "--token npm_abcdEFGHijklMNOPqrstUVWX",
        "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
        "sk-abc123abc123abc123abc123",
        "--auth-file /Users/mike/.codex/auth.json",
        "--password hunter2",
      ].join(" "),
    );

    expect(sanitized).not.toContain("npm_abcd");
    expect(sanitized).not.toContain("Bearer abcdef");
    expect(sanitized).not.toContain("sk-abc");
    expect(sanitized).not.toContain("auth.json");
    expect(sanitized).not.toContain("hunter2");
    expect(sanitized).toContain("--token [redacted]");
    expect(sanitized).toContain("Bearer [redacted]");
    expect(sanitized).toContain("[redacted-api-key]");
  });

  it("includes detached known runtime processes and marks invisible known PIDs", () => {
    const entries = buildRuntimeProcessEntries({
      readAt,
      serverPid: 100,
      rows: [
        {
          pid: 100,
          ppid: 1,
          pgid: 100,
          status: "S",
          cpuPercent: 1,
          rssBytes: 1_000,
          elapsed: "01:00",
          command: "node dist/bin.mjs",
        },
        {
          pid: 101,
          ppid: 100,
          pgid: 100,
          status: "S",
          cpuPercent: 2,
          rssBytes: 2_000,
          elapsed: "00:30",
          command: "codex app-server",
        },
        {
          pid: 300,
          ppid: 1,
          pgid: 300,
          status: "S",
          cpuPercent: 3,
          rssBytes: 3_000,
          elapsed: "00:20",
          command: "provider-daemon --token npm_abcdEFGHijklMNOPqrstUVWX",
        },
        {
          pid: 301,
          ppid: 300,
          pgid: 300,
          status: "R",
          cpuPercent: 4,
          rssBytes: 4_000,
          elapsed: "00:10",
          command: "claude --auth-file /Users/mike/.claude/auth.json",
        },
      ],
      targets: [
        {
          pid: 100,
          role: "backend",
          ownerKind: "backend-root",
          attribution: "backend",
        },
        {
          pid: 300,
          role: "provider-daemon",
          ownerKind: "daemon-marker",
          attribution: "daemon",
        },
        {
          pid: 400,
          role: "provider-supervisor",
          ownerKind: "supervisor-marker",
          attribution: "supervisor",
        },
      ],
    });

    expect(entries.map((entry) => [entry.pid, entry.role, entry.ownerKind])).toEqual([
      [100, "backend", "backend-root"],
      [300, "provider-daemon", "daemon-marker"],
      [400, "provider-supervisor", "supervisor-marker"],
      [101, "unknown-child", "backend-descendant"],
      [301, "provider-runtime", "daemon-descendant"],
    ]);
    expect(entries.find((entry) => entry.pid === 300)?.sanitizedCommand).not.toContain("npm_abcd");
    expect(entries.find((entry) => entry.pid === 301)?.sanitizedCommand).not.toContain("auth.json");
    expect(entries.find((entry) => entry.pid === 400)?.status).toBe("missing");
  });

  it("maps daemon and supervisor health without exposing command payload details", () => {
    const daemonHealth = {
      pid: 300,
      ppid: 1,
      mode: "provider-daemon",
      transport: "loopback-tcp",
      startedAt: readAt,
      activeSessionCount: 2,
      activeStreamCount: 1,
      retainedEventCount: 15,
      eventCursor: 99,
      leaseCount: 3,
      commandCount: 4,
      runningCommandCount: 1,
      completedCommandCount: 2,
      failedCommandCount: 1,
      rpc: {
        totalRpcCount: 12,
        failedRpcCount: 1,
        maxRpcDurationMs: 55,
        meanRpcDurationMs: 12.5,
      },
      persistence: {
        sqliteBusyTimeoutMs: 5_000,
      },
      recentRunningCommands: [],
      recentCompletedCommands: [],
      recentFailedCommands: [
        {
          commandId: "command-1",
          method: "sendTurn --token npm_abcdEFGHijklMNOPqrstUVWX",
          status: "failed",
          createdAt: readAt,
          updatedAt: readAt,
          durationMs: 42,
          requestSummary: {
            prompt: "do not show this prompt",
          },
          errorMessage: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
        },
      ],
      runtimeEvents: {
        recentMethodCounts: [{ key: "provider.delta", count: 3 }],
        lastEventAt: readAt,
      },
      upstreamSupervisor: {
        configured: true,
        reachable: true,
        pid: 401,
        ppid: 300,
        endpointTransport: "ipc",
        healthLatencyMs: 4,
        activeSessionCount: 1,
        activeStreamCount: 1,
        retainedEventCount: 10,
        commandCount: 2,
        runningCommandCount: 0,
        completedCommandCount: 2,
        failedCommandCount: 0,
      },
    } as unknown as ProviderDaemonHealth;

    const daemon = mapProviderDaemonHealth({
      health: daemonHealth,
      configured: true,
      reachable: true,
      healthLatencyMs: 8,
      error: null,
    });
    const supervisor = mapProviderSupervisorHealth({
      daemonHealth,
      daemonConfigured: true,
      daemonReachable: true,
    });

    expect(JSON.stringify(daemon)).not.toContain("do not show this prompt");
    expect(JSON.stringify(daemon)).not.toContain("npm_abcd");
    expect(JSON.stringify(daemon)).not.toContain("Bearer abcdef");
    expect(daemon.recentCommands[0]).toMatchObject({
      status: "failed",
      durationMs: 42,
    });
    expect(daemon.runtimeEventSummaries).toEqual([
      { eventType: "provider.delta", count: 3, lastSeenAt: readAt },
    ]);
    expect(supervisor).toMatchObject({
      configured: true,
      reachable: true,
      pid: 401,
      transport: "ipc",
      activeSessionCount: 1,
      activeStreamCount: 1,
    });
  });

  it("derives projection lag and stale-state flags", () => {
    expect(
      buildProjectorCursors({
        latestEventSequence: 50,
        projectors: [
          { projector: "fast", lastAppliedSequence: 50, updatedAt: readAt },
          { projector: "behind", lastAppliedSequence: 30, updatedAt: readAt },
          { projector: "stale", lastAppliedSequence: 1, updatedAt: readAt },
        ],
      }).map((cursor) => [cursor.projector, cursor.lag, cursor.status]),
    ).toEqual([
      ["fast", 0, "online"],
      ["behind", 20, "degraded"],
      ["stale", 49, "offline"],
    ]);

    expect(
      buildStaleStateFlags({
        counts: {
          terminalActiveSessionCount: 1,
          terminalStreamingMessageCount: 2,
        },
        daemonActiveStreams: 1,
        activeTurnCount: 0,
      }).map((flag) => flag.kind),
    ).toEqual([
      "terminal-active-session",
      "terminal-streaming-message",
      "daemon-stream-without-active-turn",
    ]);
  });

  it("describes the orchestrator as an in-process backend subsystem", () => {
    const processes = buildRuntimeProcessEntries({
      readAt,
      serverPid: 100,
      rows: [
        {
          pid: 100,
          ppid: 1,
          pgid: 100,
          status: "S",
          cpuPercent: 1,
          rssBytes: 1_000,
          elapsed: "01:00",
          command: "node dist/bin.mjs",
        },
      ],
      targets: [
        {
          pid: 100,
          role: "backend",
          ownerKind: "backend-root",
          attribution: "backend",
        },
      ],
    });

    const layers = buildLayerSummaries({
      readAt,
      serverPid: 100,
      serverStartedAt: null,
      processes,
      daemon: mapProviderDaemonHealth({
        health: null,
        configured: false,
        reachable: false,
        healthLatencyMs: null,
        error: null,
      }),
      supervisor: mapProviderSupervisorHealth({
        daemonHealth: null,
        daemonConfigured: false,
        daemonReachable: false,
      }),
      orchestratorLag: 0,
    });

    const backend = layers.find((layer) => layer.role === "backend");
    const orchestrator = layers.find((layer) => layer.role === "orchestrator");

    expect(backend).toMatchObject({
      role: "backend",
      status: "online",
      pid: 100,
      rssBytes: 1_000,
    });
    expect(orchestrator).toMatchObject({
      role: "orchestrator",
      status: "online",
      pid: null,
      rssBytes: 0,
      cpuPercent: 0,
    });
    expect(orchestrator?.notes.join(" ")).toContain("backend PID 100");
  });
});
