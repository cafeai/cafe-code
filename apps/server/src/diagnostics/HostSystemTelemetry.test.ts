import { describe, expect, it } from "vitest";

import {
  calculateCpuUtilizationPercent,
  makeHostSystemTelemetrySampler,
  memoryCountersFromRuntime,
  type CpuTimes,
  type HostSystemTelemetryRuntime,
} from "./HostSystemTelemetry.ts";

function cpuTimes(busy: number, idle: number, irq = 0): CpuTimes {
  return { user: busy, nice: 0, sys: 0, idle, irq };
}

function runtime(
  readCpuTimes: () => ReadonlyArray<CpuTimes>,
  readMemory: HostSystemTelemetryRuntime["readMemory"] = () => ({
    totalBytes: 1_000,
    availableBytes: 250,
  }),
): HostSystemTelemetryRuntime {
  return { readCpuTimes, readMemory };
}

describe("HostSystemTelemetry", () => {
  it("calculates utilization only from valid advancing CPU counters", () => {
    expect(
      calculateCpuUtilizationPercent({ total: 1_000, idle: 750 }, { total: 1_200, idle: 850 }),
    ).toBe(50);
    for (const current of [
      { total: 1_000, idle: 750 },
      { total: 1_200, idle: 1_000 },
      { total: 900, idle: 700 },
      { total: 1_200, idle: 700 },
    ]) {
      expect(calculateCpuUtilizationPercent({ total: 1_000, idle: 750 }, current)).toBeNull();
    }
  });

  it("accepts only runtime memory counters with trustworthy availability semantics", () => {
    expect(memoryCountersFromRuntime(32_000, 8_000, 3_000, "linux")).toEqual({
      totalBytes: 8_000,
      availableBytes: 3_000,
    });
    expect(memoryCountersFromRuntime(32_000, 0, 12_000, "win32")).toEqual({
      totalBytes: 32_000,
      availableBytes: 12_000,
    });

    for (const [platform, constraint] of [
      ["linux", 0],
      ["darwin", 0],
      ["darwin", 8_000],
      ["win32", 8_000],
    ] as const) {
      expect(() => memoryCountersFromRuntime(32_000, constraint, 1_000, platform)).toThrow();
    }
    for (const [hostTotalBytes, constrainedTotalBytes, availableBytes] of [
      [0, 0, 0],
      [Number.NaN, 0, 0],
      [32_000, -1, 1_000],
      [32_000, 0, -1],
      [32_000, 0, 32_001],
      [32_000, 0, Number.MAX_SAFE_INTEGER + 1],
    ] as const) {
      expect(() =>
        memoryCountersFromRuntime(hostTotalBytes, constrainedTotalBytes, availableBytes, "win32"),
      ).toThrow("Invalid runtime memory counters.");
    }
  });

  it("warms, samples, throttles CPU reads, and still samples memory", () => {
    let cpuReadCount = 0;
    let memoryReadCount = 0;
    const sampler = makeHostSystemTelemetrySampler({
      readCpuTimes: () => [cpuTimes(++cpuReadCount * 100, cpuReadCount * 300)],
      readMemory: () => {
        memoryReadCount += 1;
        return { totalBytes: 1_000, availableBytes: 250 };
      },
    });

    const first = sampler.sample({ sampledAtMonotonicMs: 1_000, platform: "linux" });
    const throttled = sampler.sample({ sampledAtMonotonicMs: 1_999, platform: "linux" });
    const available = sampler.sample({ sampledAtMonotonicMs: 2_000, platform: "linux" });

    expect(first.cpu.status).toBe("warming");
    expect(throttled.cpu).toBe(first.cpu);
    expect(available.cpu).toMatchObject({ status: "available", utilizationPercent: 25 });
    expect(available.memory).toMatchObject({
      status: "available",
      usedBytes: 750,
      availableBytes: 250,
      utilizationPercent: 75,
    });
    expect([cpuReadCount, memoryReadCount]).toEqual([2, 3]);
  });

  it.each([
    { platform: "win32", expected: 50 },
    { platform: "linux", expected: 75 },
  ])("accounts for interrupt counters on $platform", ({ platform, expected }) => {
    let cpu: ReadonlyArray<CpuTimes> = [{ user: 0, nice: 0, sys: 100, idle: 100, irq: 100 }];
    const sampler = makeHostSystemTelemetrySampler(runtime(() => cpu));
    sampler.sample({ sampledAtMonotonicMs: 1_000, platform });
    cpu = [{ user: 0, nice: 0, sys: 150, idle: 150, irq: 200 }];
    expect(sampler.sample({ sampledAtMonotonicMs: 2_000, platform }).cpu).toMatchObject({
      status: "available",
      utilizationPercent: expected,
    });
  });

  it("resets its baseline across invalid timestamps, platform changes, and topology changes", () => {
    let cpu = [cpuTimes(100, 300)];
    const sampler = makeHostSystemTelemetrySampler(runtime(() => cpu));
    expect(sampler.sample({ sampledAtMonotonicMs: Number.NaN, platform: "linux" }).cpu.status).toBe(
      "unavailable",
    );
    expect(sampler.sample({ sampledAtMonotonicMs: 1_000, platform: "linux" }).cpu.status).toBe(
      "warming",
    );
    cpu = [cpuTimes(200, 400)];
    expect(sampler.sample({ sampledAtMonotonicMs: 2_000, platform: "linux" }).cpu.status).toBe(
      "available",
    );
    expect(sampler.sample({ sampledAtMonotonicMs: 500, platform: "win32" }).cpu.status).toBe(
      "warming",
    );
    cpu = [cpuTimes(300, 500), cpuTimes(1_000, 3_000)];
    expect(sampler.sample({ sampledAtMonotonicMs: 1_500, platform: "win32" }).cpu).toMatchObject({
      status: "warming",
      logicalProcessorCount: 2,
    });
  });

  it("moves stalled CPU counters to unavailable and recovers", () => {
    let cpu = [cpuTimes(100, 300)];
    const sampler = makeHostSystemTelemetrySampler(runtime(() => cpu));
    const statuses = [1_000, 2_000, 3_000, 4_000].map(
      (sampledAtMonotonicMs) =>
        sampler.sample({ sampledAtMonotonicMs, platform: "linux" }).cpu.status,
    );
    expect(statuses).toEqual(["warming", "warming", "warming", "unavailable"]);
    cpu = [cpuTimes(200, 400)];
    expect(sampler.sample({ sampledAtMonotonicMs: 5_000, platform: "linux" }).cpu).toMatchObject({
      status: "available",
      utilizationPercent: 50,
    });
  });

  it("fails malformed, overflowing, and exceptional counters closed", () => {
    const malformedMemory = makeHostSystemTelemetrySampler(
      runtime(
        () => [cpuTimes(1, 3)],
        () => ({ totalBytes: 1_000, availableBytes: 1_001 }),
      ),
    ).sample({ sampledAtMonotonicMs: 1_000, platform: "linux" });
    expect(malformedMemory.memory).toMatchObject({
      status: "unavailable",
      totalBytes: null,
      utilizationPercent: null,
    });

    const nearLimit = Math.floor(Number.MAX_SAFE_INTEGER / 2);
    const overflow = makeHostSystemTelemetrySampler(
      runtime(() => [cpuTimes(nearLimit, nearLimit), cpuTimes(nearLimit, nearLimit)]),
    ).sample({ sampledAtMonotonicMs: 1_000, platform: "linux" });
    expect(overflow.cpu).toMatchObject({ status: "unavailable", logicalProcessorCount: 2 });

    const exceptional = makeHostSystemTelemetrySampler({
      readCpuTimes: () => {
        throw new Error("private CPU detail");
      },
      readMemory: () => {
        throw new Error("private memory detail");
      },
    }).sample({ sampledAtMonotonicMs: 1_000, platform: "darwin" });
    expect(exceptional.cpu.status).toBe("unavailable");
    expect(exceptional.memory.status).toBe("unavailable");
    expect(JSON.stringify(exceptional)).not.toContain("private");
  });

  it("preserves a healthy baseline across a transient CPU read failure", () => {
    let cpu = [cpuTimes(100, 300)];
    let failing = false;
    const sampler = makeHostSystemTelemetrySampler(
      runtime(() => {
        if (failing) throw new Error("transient");
        return cpu;
      }),
    );
    sampler.sample({ sampledAtMonotonicMs: 1_000, platform: "linux" });
    cpu = [cpuTimes(200, 400)];
    sampler.sample({ sampledAtMonotonicMs: 2_000, platform: "linux" });
    failing = true;
    expect(sampler.sample({ sampledAtMonotonicMs: 3_000, platform: "linux" }).cpu.status).toBe(
      "unavailable",
    );
    failing = false;
    cpu = [cpuTimes(300, 500)];
    expect(sampler.sample({ sampledAtMonotonicMs: 4_000, platform: "linux" }).cpu).toMatchObject({
      status: "available",
      utilizationPercent: 50,
    });
  });
});
