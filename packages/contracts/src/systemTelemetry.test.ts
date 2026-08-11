import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import {
  ServerProjectSystemTelemetryError,
  ServerProjectSystemTelemetryInput,
  ServerProjectSystemTelemetryResult,
} from "./systemTelemetry.ts";

const decodeProjectSystemTelemetry = Schema.decodeUnknownSync(ServerProjectSystemTelemetryResult);
const decodeProjectSystemTelemetryInput = Schema.decodeUnknownSync(
  ServerProjectSystemTelemetryInput,
);
const encodeProjectSystemTelemetryError = Schema.encodeSync(ServerProjectSystemTelemetryError);

function projectSystemTelemetryFixture() {
  return {
    projectId: "project-1",
    sampledAt: DateTime.makeUnsafe("2026-07-25T12:00:00.000Z"),
    minimumSampleIntervalMs: 1_000,
    platform: "linux",
    architecture: "arm64",
    cpu: {
      status: "available",
      utilizationPercent: 42,
      logicalProcessorCount: 4,
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
      usedBytes: 7_500,
      availableBytes: 2_500,
      utilizationPercent: 75,
      projectVolumeOnly: true,
      detail: null,
    },
  };
}

describe("ServerProjectSystemTelemetryResult", () => {
  it("accepts only a project ID at the endpoint boundary", () => {
    const parsed = decodeProjectSystemTelemetryInput({
      projectId: "project-1",
      workspaceRoot: "/renderer-controlled",
    });

    expect(parsed).toEqual({ projectId: "project-1" });
    expect("workspaceRoot" in parsed).toBe(false);
  });

  it("uses bounded lookup failures without a raw cause field", () => {
    const failure = new ServerProjectSystemTelemetryError({
      kind: "project-lookup-failed",
      message: "Failed to resolve the selected project.",
    });
    const encoded = encodeProjectSystemTelemetryError(failure);

    expect(encoded).toMatchObject({
      _tag: "ServerProjectSystemTelemetryError",
      kind: "project-lookup-failed",
      message: "Failed to resolve the selected project.",
    });
    expect("cause" in encoded).toBe(false);
  });

  it("decodes bounded, project-volume-scoped telemetry", () => {
    const parsed = decodeProjectSystemTelemetry(projectSystemTelemetryFixture());

    expect(parsed.projectId).toBe("project-1");
    expect(parsed.memory.availableBytes).toBe(2_000);
    expect(parsed.projectVolume.availableBytes).toBe(2_500);
    expect(parsed.projectVolume.projectVolumeOnly).toBe(true);
  });

  it("rejects fabricated percentages outside the telemetry range", () => {
    const input = projectSystemTelemetryFixture();
    expect(() =>
      decodeProjectSystemTelemetry({
        ...input,
        cpu: { ...input.cpu, utilizationPercent: 101 },
      }),
    ).toThrow();
  });

  it("requires the disk sample to identify itself as project-volume-only", () => {
    const input = projectSystemTelemetryFixture();
    expect(() =>
      decodeProjectSystemTelemetry({
        ...input,
        projectVolume: { ...input.projectVolume, projectVolumeOnly: false },
      }),
    ).toThrow();
  });

  it("does not allow unavailable metrics to masquerade as measured zeroes", () => {
    const input = projectSystemTelemetryFixture();
    expect(() =>
      decodeProjectSystemTelemetry({
        ...input,
        memory: {
          status: "unavailable",
          totalBytes: 0,
          usedBytes: 0,
          availableBytes: 0,
          utilizationPercent: 0,
          detail: "Unavailable.",
        },
      }),
    ).toThrow();
  });

  it("round-trips an unavailable project-volume sample without fabricated values", () => {
    const input = projectSystemTelemetryFixture();
    const parsed = decodeProjectSystemTelemetry({
      ...input,
      projectVolume: {
        status: "unavailable",
        totalBytes: null,
        usedBytes: null,
        availableBytes: null,
        utilizationPercent: null,
        projectVolumeOnly: true,
        detail: "Project-volume telemetry is unavailable.",
      },
    });

    expect(parsed.projectVolume).toEqual({
      status: "unavailable",
      totalBytes: null,
      usedBytes: null,
      availableBytes: null,
      utilizationPercent: null,
      projectVolumeOnly: true,
      detail: "Project-volume telemetry is unavailable.",
    });
  });

  it("represents measured memory exhaustion without confusing it with unavailable data", () => {
    const input = projectSystemTelemetryFixture();
    const parsed = decodeProjectSystemTelemetry({
      ...input,
      memory: {
        ...input.memory,
        usedBytes: input.memory.totalBytes,
        availableBytes: 0,
        utilizationPercent: 100,
      },
    });

    expect(parsed.memory).toEqual({
      status: "available",
      totalBytes: input.memory.totalBytes,
      usedBytes: input.memory.totalBytes,
      availableBytes: 0,
      utilizationPercent: 100,
      detail: null,
    });
  });

  it.each([
    {
      label: "memory used bytes do not match total minus available",
      update: (input: ReturnType<typeof projectSystemTelemetryFixture>) => ({
        memory: { ...input.memory, usedBytes: 5_999 },
      }),
    },
    {
      label: "memory percentage does not match its byte counters",
      update: (input: ReturnType<typeof projectSystemTelemetryFixture>) => ({
        memory: { ...input.memory, utilizationPercent: 50 },
      }),
    },
    {
      label: "project-volume addressable bytes exceed total",
      update: (input: ReturnType<typeof projectSystemTelemetryFixture>) => ({
        projectVolume: { ...input.projectVolume, availableBytes: 3_000 },
      }),
    },
    {
      label: "project-volume percentage does not use its addressable capacity",
      update: (input: ReturnType<typeof projectSystemTelemetryFixture>) => ({
        projectVolume: { ...input.projectVolume, utilizationPercent: 70 },
      }),
    },
  ])("rejects contradictory telemetry: $label", ({ update }) => {
    const input = projectSystemTelemetryFixture();
    expect(() => decodeProjectSystemTelemetry({ ...input, ...update(input) })).toThrow();
  });

  it("rejects an available project volume with no addressable capacity", () => {
    const input = projectSystemTelemetryFixture();
    expect(() =>
      decodeProjectSystemTelemetry({
        ...input,
        projectVolume: {
          ...input.projectVolume,
          usedBytes: 0,
          availableBytes: 0,
          utilizationPercent: 0,
        },
      }),
    ).toThrow();
  });

  it("accepts a project-volume percentage rounded to whole-percent probe precision", () => {
    const input = projectSystemTelemetryFixture();
    const parsed = decodeProjectSystemTelemetry({
      ...input,
      projectVolume: {
        ...input.projectVolume,
        usedBytes: 7_499,
        availableBytes: 2_501,
        utilizationPercent: 75,
      },
    });

    expect(parsed.projectVolume).toMatchObject({
      status: "available",
      usedBytes: 7_499,
      availableBytes: 2_501,
      utilizationPercent: 75,
    });
  });
});
