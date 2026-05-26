import { describe, expect, it } from "vitest";
import type { ServerRuntimeLayerDiagnosticsResult } from "@cafecode/contracts";

import {
  formatRuntimeLayerRole,
  runtimeLayerStatusClasses,
  runtimeLayerStatusTone,
  sortRuntimeLayers,
  summarizeRuntimeCpu,
  summarizeRuntimeMemory,
  visibleRuntimeErrors,
} from "./diagnosticsRuntimeViewModel";

describe("diagnosticsRuntimeViewModel", () => {
  it("formats runtime layer labels and status tones", () => {
    expect(formatRuntimeLayerRole("provider-daemon")).toBe("Provider Daemon");
    expect(runtimeLayerStatusTone("online")).toBe("default");
    expect(runtimeLayerStatusTone("degraded")).toBe("warning");
    expect(runtimeLayerStatusTone("unknown")).toBe("warning");
    expect(runtimeLayerStatusTone("offline")).toBe("danger");
    expect(runtimeLayerStatusClasses("online")).toContain("emerald");
    expect(runtimeLayerStatusClasses("offline")).toContain("destructive");
  });

  it("sorts primary layers before detached child roles", () => {
    expect(
      sortRuntimeLayers([
        {
          role: "unknown-child",
          status: "unknown",
          pid: null,
          rssBytes: 0,
          cpuPercent: 0,
          uptimeLabel: null,
          lastEventAt: null,
          notes: [],
        },
        {
          role: "provider-daemon",
          status: "online",
          pid: 300,
          rssBytes: 1,
          cpuPercent: 1,
          uptimeLabel: null,
          lastEventAt: null,
          notes: [],
        },
        {
          role: "backend",
          status: "online",
          pid: 100,
          rssBytes: 1,
          cpuPercent: 1,
          uptimeLabel: null,
          lastEventAt: null,
          notes: [],
        },
      ]).map((layer) => layer.role),
    ).toEqual(["backend", "provider-daemon", "unknown-child"]);
  });

  it("summarizes process resources", () => {
    const processes = [
      {
        role: "backend" as const,
        ownerKind: "backend-root" as const,
        pid: 100,
        ppid: 1,
        status: "S",
        cpuPercent: 1.25,
        rssBytes: 1000,
        elapsed: "00:10",
        commandLabel: "node",
        sanitizedCommand: "node dist/bin.mjs",
        depth: 0,
        childPids: [101],
        attribution: "backend",
        lastSeenAt: "2026-05-26T00:00:00.000Z",
        notes: [],
      },
      {
        role: "provider-runtime" as const,
        ownerKind: "daemon-descendant" as const,
        pid: 101,
        ppid: 100,
        status: "R",
        cpuPercent: 2.75,
        rssBytes: 2000,
        elapsed: "00:05",
        commandLabel: "codex",
        sanitizedCommand: "codex app-server",
        depth: 1,
        childPids: [],
        attribution: "daemon",
        lastSeenAt: "2026-05-26T00:00:00.000Z",
        notes: [],
      },
    ];

    expect(summarizeRuntimeMemory(processes)).toBe(3000);
    expect(summarizeRuntimeCpu(processes)).toBe(4);
  });

  it("combines client and server diagnostic errors", () => {
    const data = {
      errors: [{ source: "provider-daemon", message: "daemon unavailable" }],
    } as unknown as ServerRuntimeLayerDiagnosticsResult;

    expect(visibleRuntimeErrors(data, "client failed")).toEqual([
      { source: "client", message: "client failed" },
      { source: "provider-daemon", message: "daemon unavailable" },
    ]);
    expect(visibleRuntimeErrors(null, null)).toEqual([]);
  });
});
