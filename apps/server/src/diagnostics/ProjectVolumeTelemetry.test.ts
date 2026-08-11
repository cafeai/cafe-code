import { describe, expect, it } from "vitest";

import {
  type ProjectVolumeCounters,
  projectVolumeMetricFromCounters,
  unavailableProjectVolumeTelemetry,
} from "./ProjectVolumeTelemetry.ts";

describe("ProjectVolumeTelemetry", () => {
  it("derives disk use without charging filesystem-reserved blocks to the project", () => {
    const metric = projectVolumeMetricFromCounters({
      blockSize: 10n,
      blocks: 100n,
      freeBlocks: 30n,
      availableBlocks: 20n,
    });

    expect(metric).toMatchObject({
      status: "available",
      totalBytes: 1_000,
      usedBytes: 700,
      availableBytes: 200,
      projectVolumeOnly: true,
      detail: null,
    });
    expect(metric.utilizationPercent).toBeCloseTo(77.777_777, 5);
  });

  it("handles the Windows-style case where free and available blocks are equal", () => {
    expect(
      projectVolumeMetricFromCounters({
        blockSize: 10n,
        blocks: 100n,
        freeBlocks: 30n,
        availableBlocks: 30n,
      }),
    ).toMatchObject({
      status: "available",
      totalBytes: 1_000,
      usedBytes: 700,
      availableBytes: 300,
      utilizationPercent: 70,
    });
  });

  it.each([
    {
      name: "zero block size",
      counters: { blockSize: 0n, blocks: 100n, freeBlocks: 10n, availableBlocks: 10n },
    },
    {
      name: "zero block count",
      counters: { blockSize: 1n, blocks: 0n, freeBlocks: 0n, availableBlocks: 0n },
    },
    {
      name: "negative free blocks",
      counters: { blockSize: 1n, blocks: 100n, freeBlocks: -1n, availableBlocks: 0n },
    },
    {
      name: "negative available blocks",
      counters: { blockSize: 1n, blocks: 100n, freeBlocks: 10n, availableBlocks: -1n },
    },
    {
      name: "available blocks above free blocks",
      counters: { blockSize: 1n, blocks: 100n, freeBlocks: 10n, availableBlocks: 20n },
    },
    {
      name: "free blocks above total blocks",
      counters: { blockSize: 1n, blocks: 100n, freeBlocks: 101n, availableBlocks: 1n },
    },
  ] satisfies ReadonlyArray<{ readonly name: string; readonly counters: ProjectVolumeCounters }>)(
    "rejects impossible counters: $name",
    ({ counters }) => {
      expect(projectVolumeMetricFromCounters(counters)).toEqual(
        unavailableProjectVolumeTelemetry(),
      );
    },
  );

  it("rejects byte products that cannot cross the number contract without rounding", () => {
    const firstUnsafeBlockCount = BigInt(Number.MAX_SAFE_INTEGER) / 2n + 1n;
    expect(
      projectVolumeMetricFromCounters({
        blockSize: 2n,
        blocks: firstUnsafeBlockCount,
        freeBlocks: 0n,
        availableBlocks: 0n,
      }),
    ).toEqual(unavailableProjectVolumeTelemetry());
  });

  it("accepts the largest exactly representable byte total", () => {
    expect(
      projectVolumeMetricFromCounters({
        blockSize: 1n,
        blocks: BigInt(Number.MAX_SAFE_INTEGER),
        freeBlocks: 0n,
        availableBlocks: 0n,
      }),
    ).toMatchObject({
      status: "available",
      totalBytes: Number.MAX_SAFE_INTEGER,
      usedBytes: Number.MAX_SAFE_INTEGER,
      availableBytes: 0,
      utilizationPercent: 100,
    });
  });

  it("reports honest zero and full utilization at the valid boundaries", () => {
    expect(
      projectVolumeMetricFromCounters({
        blockSize: 1n,
        blocks: 100n,
        freeBlocks: 100n,
        availableBlocks: 100n,
      }),
    ).toMatchObject({
      status: "available",
      totalBytes: 100,
      usedBytes: 0,
      availableBytes: 100,
      utilizationPercent: 0,
    });
    expect(
      projectVolumeMetricFromCounters({
        blockSize: 1n,
        blocks: 100n,
        freeBlocks: 0n,
        availableBlocks: 0n,
      }),
    ).toMatchObject({
      status: "available",
      totalBytes: 100,
      usedBytes: 100,
      availableBytes: 0,
      utilizationPercent: 100,
    });
  });

  it("fails closed when reserved blocks leave utilization mathematically undefined", () => {
    expect(
      projectVolumeMetricFromCounters({
        blockSize: 1n,
        blocks: 100n,
        freeBlocks: 100n,
        availableBlocks: 0n,
      }),
    ).toEqual(unavailableProjectVolumeTelemetry());
  });

  it("fails closed for malformed runtime counter values", () => {
    const malformed = {
      blockSize: 1,
      blocks: 100n,
      freeBlocks: 10n,
      availableBlocks: 10n,
    } as unknown as ProjectVolumeCounters;
    expect(() => projectVolumeMetricFromCounters(malformed)).not.toThrow();
    expect(projectVolumeMetricFromCounters(malformed)).toEqual(unavailableProjectVolumeTelemetry());
  });

  it("uses one bounded path-free unavailable payload", () => {
    const metric = unavailableProjectVolumeTelemetry();
    expect(metric).toEqual({
      status: "unavailable",
      totalBytes: null,
      usedBytes: null,
      availableBytes: null,
      utilizationPercent: null,
      projectVolumeOnly: true,
      detail: "Project-volume telemetry is unavailable.",
    });
    expect(JSON.stringify(metric)).not.toContain("\\");
  });
});
