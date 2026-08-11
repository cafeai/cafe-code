import { ProjectId, type ServerProjectSystemTelemetryResult } from "@cafecode/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vitest";

import {
  appendBoundedTelemetryHistory,
  buildTelemetrySparklinePath,
  formatTelemetryBytes,
  projectTelemetryGpuAdapter,
  toProjectTelemetryHistoryPoint,
  type ProjectTelemetryHistoryPoint,
} from "./ProjectTelemetryGraph.model";

function telemetryFixture(): ServerProjectSystemTelemetryResult {
  return {
    projectId: ProjectId.make("project-telemetry-graph"),
    sampledAt: DateTime.makeUnsafe("2026-07-26T12:00:00.000Z"),
    minimumSampleIntervalMs: 1_000,
    platform: "linux",
    architecture: "arm64",
    cpu: {
      status: "available",
      utilizationPercent: 42,
      logicalProcessorCount: 8,
      detail: null,
    },
    memory: {
      status: "available",
      totalBytes: 8_000,
      usedBytes: 6_000,
      availableBytes: 2_000,
      utilizationPercent: 75,
      detail: null,
    },
    projectVolume: {
      status: "available",
      totalBytes: 10_000,
      usedBytes: 6_500,
      availableBytes: 3_500,
      utilizationPercent: 65,
      projectVolumeOnly: true,
      detail: null,
    },
  };
}

function telemetryWithGpu(gpu: unknown): ServerProjectSystemTelemetryResult {
  return { ...telemetryFixture(), gpu } as ServerProjectSystemTelemetryResult;
}

function gpuAdapter(overrides: Record<string, unknown> = {}) {
  return {
    index: 0,
    name: "GPU 0",
    utilizationPercent: 50,
    memoryTotalBytes: 8_000,
    memoryUsedBytes: 2_000,
    memoryUtilizationPercent: 25,
    ...overrides,
  };
}

function historyPoint(sampledAtMs: number): ProjectTelemetryHistoryPoint {
  return {
    sampledAtMs,
    cpuPercent: sampledAtMs,
    memoryPercent: sampledAtMs,
    projectVolumePercent: sampledAtMs,
    gpuPercent: null,
    vramPercent: null,
  };
}

describe("ProjectTelemetryGraph model", () => {
  it("keeps history bounded and ordered", () => {
    let history: readonly ProjectTelemetryHistoryPoint[] = [];
    for (let index = 0; index < 12; index += 1) {
      history = appendBoundedTelemetryHistory(history, historyPoint(index), 5);
    }
    expect(history.map((point) => point.sampledAtMs)).toEqual([7, 8, 9, 10, 11]);
    expect(appendBoundedTelemetryHistory(history, historyPoint(12), Number.NaN)).toEqual([
      historyPoint(12),
    ]);
    expect(
      appendBoundedTelemetryHistory(history, historyPoint(12), Number.POSITIVE_INFINITY),
    ).toHaveLength(6);
  });

  it("keeps unavailable samples as visible gaps instead of fabricated zeroes", () => {
    expect(buildTelemetrySparklinePath([10, null, 80])).toBe(
      "M 0.00 21.60 L 0.00 21.60M 100.00 4.80 L 100.00 4.80",
    );
    expect(buildTelemetrySparklinePath([])).toBe("");
    expect(buildTelemetrySparklinePath([50])).toBe("M 0.00 12.00 L 0.00 12.00");
    expect(buildTelemetrySparklinePath([-10, 110])).toBe("M 0.00 24.00 L 0.00 24.00 L 100.00 0.00");
  });

  it("formats project-volume bytes without changing their meaning", () => {
    expect(formatTelemetryBytes(0)).toBe("0 B");
    expect(formatTelemetryBytes(100)).toBe("100 B");
    expect(formatTelemetryBytes(1.5 * 1024)).toBe("1.5 KiB");
    expect(formatTelemetryBytes(3 * 1024 ** 3)).toBe("3 GiB");
    expect(formatTelemetryBytes(1024 ** 5)).toBe("1 PiB");
    expect(formatTelemetryBytes(-1)).toBe("Unavailable");
    expect(formatTelemetryBytes(0.5)).toBe("Unavailable");
    expect(formatTelemetryBytes(Number.NaN)).toBe("Unavailable");
    expect(formatTelemetryBytes(null)).toBe("Unavailable");
  });

  it("projects CPU, RAM, and project-volume utilization while GPU remains honest", () => {
    const telemetry = telemetryFixture();
    const gpu = projectTelemetryGpuAdapter(telemetry);
    const point = toProjectTelemetryHistoryPoint(telemetry, gpu);

    expect(point).toMatchObject({
      cpuPercent: 42,
      memoryPercent: 75,
      projectVolumePercent: 65,
      gpuPercent: null,
      vramPercent: null,
    });
    expect(gpu.gpuDetail).toContain("unavailable");
  });

  it("maps non-available host metrics to gaps", () => {
    const telemetry = {
      ...telemetryFixture(),
      cpu: {
        status: "warming",
        utilizationPercent: null,
        logicalProcessorCount: 8,
        detail: "Collecting a baseline.",
      },
      memory: {
        status: "unavailable",
        totalBytes: null,
        usedBytes: null,
        availableBytes: null,
        utilizationPercent: null,
        detail: "Memory unavailable.",
      },
      projectVolume: {
        status: "unavailable",
        totalBytes: null,
        usedBytes: null,
        availableBytes: null,
        utilizationPercent: null,
        projectVolumeOnly: true,
        detail: "Volume unavailable.",
      },
    } as ServerProjectSystemTelemetryResult;

    expect(
      toProjectTelemetryHistoryPoint(telemetry, projectTelemetryGpuAdapter(telemetry)),
    ).toMatchObject({
      cpuPercent: null,
      memoryPercent: null,
      projectVolumePercent: null,
      gpuPercent: null,
      vramPercent: null,
    });
  });

  it("accepts bounded GPU fields through the independent adapter seam", () => {
    const telemetry = {
      ...telemetryFixture(),
      gpu: {
        status: "available",
        detail: null,
        adapters: [
          {
            index: 0,
            name: "GPU 0",
            utilizationPercent: 55,
            memoryTotalBytes: 8_000,
            memoryUsedBytes: 2_000,
            memoryUtilizationPercent: 25,
          },
          {
            index: 1,
            name: "GPU 1",
            utilizationPercent: 35,
            memoryTotalBytes: 4_000,
            memoryUsedBytes: 1_000,
            memoryUtilizationPercent: 25,
          },
        ],
      },
    } as ServerProjectSystemTelemetryResult;

    expect(projectTelemetryGpuAdapter(telemetry)).toMatchObject({
      gpuPercent: 55,
      vramPercent: 25,
      vramUsedBytes: 3_000,
      vramAvailableBytes: 9_000,
    });
  });

  it.each([
    ["empty adapter list", { status: "available", detail: null, adapters: [] }],
    [
      "too many adapters",
      {
        status: "available",
        detail: null,
        adapters: Array.from({ length: 65 }, () => gpuAdapter()),
      },
    ],
    ["non-object adapter", { status: "available", detail: null, adapters: [null] }],
    [
      "invalid utilization",
      { status: "available", detail: null, adapters: [gpuAdapter({ utilizationPercent: 101 })] },
    ],
  ])("rejects malformed GPU data: %s", (_label, gpu) => {
    expect(projectTelemetryGpuAdapter(telemetryWithGpu(gpu)).gpuPercent).toBeNull();
  });

  it("preserves a backend unavailable detail", () => {
    expect(
      projectTelemetryGpuAdapter(
        telemetryWithGpu({ status: "unavailable", detail: "GPU driver unavailable." }),
      ),
    ).toMatchObject({
      gpuPercent: null,
      gpuDetail: "GPU driver unavailable.",
      vramPercent: null,
      vramDetail: "GPU driver unavailable.",
    });
  });

  it.each([
    ["zero total", [gpuAdapter({ memoryTotalBytes: 0, memoryUsedBytes: 0 })]],
    ["used exceeds total", [gpuAdapter({ memoryTotalBytes: 1, memoryUsedBytes: 2 })]],
    ["invalid memory percent", [gpuAdapter({ memoryUtilizationPercent: Number.NaN })]],
    [
      "aggregate overflow",
      [
        gpuAdapter({ memoryTotalBytes: Number.MAX_SAFE_INTEGER, memoryUsedBytes: 0 }),
        gpuAdapter({ memoryTotalBytes: Number.MAX_SAFE_INTEGER, memoryUsedBytes: 0 }),
      ],
    ],
  ])("keeps GPU utilization but rejects invalid VRAM data: %s", (_label, adapters) => {
    const projection = projectTelemetryGpuAdapter(
      telemetryWithGpu({ status: "available", detail: "VRAM unavailable.", adapters }),
    );
    expect(projection).toMatchObject({
      gpuPercent: 50,
      vramPercent: null,
      vramUsedBytes: null,
      vramAvailableBytes: null,
      vramDetail: "VRAM unavailable.",
    });
  });
});
