import * as NodeOS from "node:os";

import type { ServerSystemCpuTelemetry, ServerSystemMemoryTelemetry } from "@cafecode/contracts";

export const HOST_SYSTEM_TELEMETRY_MINIMUM_SAMPLE_INTERVAL_MS = 1_000;
export const CPU_INVALID_DELTA_UNAVAILABLE_THRESHOLD = 3;

const CPU_WARMING_DETAIL = "Waiting for a second CPU sample.";
const CPU_UNAVAILABLE_DETAIL = "CPU telemetry is unavailable.";
const CPU_STALLED_DETAIL = "CPU counters are not advancing consistently.";
const MEMORY_UNAVAILABLE_DETAIL = "Memory telemetry is unavailable.";

export interface CpuTimes {
  readonly user: number;
  readonly nice: number;
  readonly sys: number;
  readonly idle: number;
  readonly irq: number;
}

export interface MemoryCounters {
  /** Process-effective memory ceiling, including an OS/container limit when present. */
  readonly totalBytes: number;
  /** Memory still available to this process, not a raw host-wide free-memory counter. */
  readonly availableBytes: number;
}

export interface HostSystemTelemetryRuntime {
  readonly readCpuTimes: () => ReadonlyArray<CpuTimes>;
  readonly readMemory: () => MemoryCounters;
}

export interface HostSystemTelemetrySample {
  readonly cpu: ServerSystemCpuTelemetry;
  readonly memory: ServerSystemMemoryTelemetry;
}

export interface HostSystemTelemetrySamplerShape {
  /**
   * Sampling is synchronous so one service-owned sampler can safely share its
   * CPU baseline across otherwise concurrent project reads on the Node event loop.
   */
  readonly sample: (input: {
    /** A finite monotonic timestamp supplied by the owning telemetry service. */
    readonly sampledAtMonotonicMs: number;
    /** The Node platform whose CPU counter accounting produced this sample. */
    readonly platform: string;
  }) => HostSystemTelemetrySample;
}

interface CpuAggregate {
  readonly total: number;
  readonly idle: number;
}

interface CpuSampleState {
  readonly sampledAtMonotonicMs: number;
  readonly platform: string;
  readonly aggregate: CpuAggregate | null;
  readonly logicalProcessorCount: number;
  readonly consecutiveInvalidDeltas: number;
  readonly metric: ServerSystemCpuTelemetry;
}

function isSafeNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function boundedPercent(used: number, total: number): number | null {
  if (!Number.isFinite(used) || !Number.isFinite(total) || used < 0 || total <= 0) {
    return null;
  }
  return Math.min(100, Math.max(0, (used / total) * 100));
}

function aggregateCpuTimes(times: ReadonlyArray<CpuTimes>, platform: string): CpuAggregate | null {
  if (times.length === 0) {
    return null;
  }

  let total = 0;
  let idle = 0;
  for (const entry of times) {
    // Node/libuv reports Windows interrupt time inside `sys`; Unix-like
    // platforms expose it as a separate counter.
    const irq = platform === "win32" ? 0 : entry.irq;
    const values = [entry.user, entry.nice, entry.sys, entry.idle, irq];
    if (values.some((value) => !isSafeNonNegativeInteger(value))) {
      return null;
    }
    total += values.reduce((sum, value) => sum + value, 0);
    idle += entry.idle;
  }

  return Number.isSafeInteger(total) && Number.isSafeInteger(idle) ? { total, idle } : null;
}

export function calculateCpuUtilizationPercent(
  previous: CpuAggregate,
  current: CpuAggregate,
): number | null {
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (
    !Number.isFinite(totalDelta) ||
    !Number.isFinite(idleDelta) ||
    totalDelta <= 0 ||
    idleDelta < 0 ||
    idleDelta > totalDelta
  ) {
    return null;
  }
  return boundedPercent(totalDelta - idleDelta, totalDelta);
}

function unavailableCpu(logicalProcessorCount = 0): ServerSystemCpuTelemetry {
  return {
    status: "unavailable",
    utilizationPercent: null,
    logicalProcessorCount,
    detail: CPU_UNAVAILABLE_DETAIL,
  };
}

function sampleCpu(
  runtime: HostSystemTelemetryRuntime,
  previous: CpuSampleState | null,
  sampledAtMonotonicMs: number,
  platform: string,
): CpuSampleState {
  if (
    previous &&
    platform === previous.platform &&
    sampledAtMonotonicMs >= previous.sampledAtMonotonicMs &&
    sampledAtMonotonicMs - previous.sampledAtMonotonicMs <
      HOST_SYSTEM_TELEMETRY_MINIMUM_SAMPLE_INTERVAL_MS
  ) {
    return previous;
  }

  try {
    const times = runtime.readCpuTimes();
    const aggregate = aggregateCpuTimes(times, platform);
    if (!aggregate) {
      const samePlatform = previous !== null && platform === previous.platform;
      const sameTopology = samePlatform && times.length === previous.logicalProcessorCount;
      return {
        sampledAtMonotonicMs,
        platform,
        aggregate: sameTopology ? previous.aggregate : null,
        logicalProcessorCount: sameTopology ? previous.logicalProcessorCount : times.length,
        consecutiveInvalidDeltas: sameTopology ? previous.consecutiveInvalidDeltas : 0,
        metric: unavailableCpu(times.length),
      };
    }

    if (
      !previous?.aggregate ||
      platform !== previous.platform ||
      sampledAtMonotonicMs < previous.sampledAtMonotonicMs ||
      times.length !== previous.logicalProcessorCount
    ) {
      return {
        sampledAtMonotonicMs,
        platform,
        aggregate,
        logicalProcessorCount: times.length,
        consecutiveInvalidDeltas: 0,
        metric: {
          status: "warming",
          utilizationPercent: null,
          logicalProcessorCount: times.length,
          detail: CPU_WARMING_DETAIL,
        },
      };
    }

    const utilizationPercent = calculateCpuUtilizationPercent(previous.aggregate, aggregate);
    const consecutiveInvalidDeltas =
      utilizationPercent === null ? previous.consecutiveInvalidDeltas + 1 : 0;
    return {
      sampledAtMonotonicMs,
      platform,
      aggregate,
      logicalProcessorCount: times.length,
      consecutiveInvalidDeltas,
      metric:
        utilizationPercent === null
          ? consecutiveInvalidDeltas >= CPU_INVALID_DELTA_UNAVAILABLE_THRESHOLD
            ? {
                status: "unavailable",
                utilizationPercent: null,
                logicalProcessorCount: times.length,
                detail: CPU_STALLED_DETAIL,
              }
            : {
                status: "warming",
                utilizationPercent: null,
                logicalProcessorCount: times.length,
                detail: CPU_WARMING_DETAIL,
              }
          : {
              status: "available",
              utilizationPercent,
              logicalProcessorCount: times.length,
              detail: null,
            },
    };
  } catch {
    const samePlatform = previous !== null && platform === previous.platform;
    const logicalProcessorCount = samePlatform ? previous.logicalProcessorCount : 0;
    return {
      sampledAtMonotonicMs,
      platform,
      aggregate: samePlatform ? previous.aggregate : null,
      logicalProcessorCount,
      consecutiveInvalidDeltas: samePlatform ? previous.consecutiveInvalidDeltas : 0,
      metric: unavailableCpu(logicalProcessorCount),
    };
  }
}

function sampleMemory(runtime: HostSystemTelemetryRuntime): ServerSystemMemoryTelemetry {
  try {
    const { totalBytes, availableBytes } = runtime.readMemory();
    if (
      !isSafeNonNegativeInteger(totalBytes) ||
      !isSafeNonNegativeInteger(availableBytes) ||
      totalBytes <= 0 ||
      availableBytes > totalBytes
    ) {
      throw new Error("Invalid memory counters.");
    }
    const usedBytes = totalBytes - availableBytes;
    const utilizationPercent = boundedPercent(usedBytes, totalBytes);
    if (utilizationPercent === null) {
      throw new Error("Invalid memory utilization.");
    }
    return {
      status: "available",
      totalBytes,
      usedBytes,
      availableBytes,
      utilizationPercent,
      detail: null,
    };
  } catch {
    return {
      status: "unavailable",
      totalBytes: null,
      usedBytes: null,
      availableBytes: null,
      utilizationPercent: null,
      detail: MEMORY_UNAVAILABLE_DETAIL,
    };
  }
}

export function memoryCountersFromRuntime(
  hostTotalBytes: number,
  constrainedTotalBytes: number,
  availableBytes: number,
  platform: NodeJS.Platform,
): MemoryCounters {
  if (
    !isSafeNonNegativeInteger(hostTotalBytes) ||
    hostTotalBytes <= 0 ||
    !isSafeNonNegativeInteger(constrainedTotalBytes) ||
    !isSafeNonNegativeInteger(availableBytes)
  ) {
    throw new Error("Invalid runtime memory counters.");
  }
  const hasEffectiveConstraint =
    isSafeNonNegativeInteger(constrainedTotalBytes) &&
    constrainedTotalBytes > 0 &&
    constrainedTotalBytes < hostTotalBytes;
  // Libuv documents that unconstrained `uv_get_available_memory()` falls back
  // to `uv_get_free_memory()`. Linux and macOS raw free-page counters exclude
  // substantial reusable cache/inactive memory, so presenting them as
  // process-available makes a healthy machine look nearly exhausted. Windows'
  // available-physical-memory counter is pressure-aware; constrained Linux is
  // also supported because libuv accounts for the cgroup limit there.
  const supportsTrustworthyAvailableMemory =
    (platform === "win32" && !hasEffectiveConstraint) ||
    (platform === "linux" && hasEffectiveConstraint);
  if (!supportsTrustworthyAvailableMemory) {
    throw new Error("Process-available memory is unsupported on this platform.");
  }
  const totalBytes = hasEffectiveConstraint ? constrainedTotalBytes : hostTotalBytes;
  if (availableBytes > totalBytes) {
    throw new Error("Invalid runtime memory counters.");
  }
  return { totalBytes, availableBytes };
}

export function makeLiveHostSystemTelemetryRuntime(): HostSystemTelemetryRuntime {
  return {
    readCpuTimes: () => NodeOS.cpus().map(({ times }) => times),
    readMemory: () =>
      memoryCountersFromRuntime(
        NodeOS.totalmem(),
        process.constrainedMemory(),
        process.availableMemory(),
        process.platform,
      ),
  };
}

export function makeHostSystemTelemetrySampler(
  runtime: HostSystemTelemetryRuntime,
): HostSystemTelemetrySamplerShape {
  let cpuState: CpuSampleState | null = null;

  return {
    sample: (input) => {
      if (!Number.isFinite(input.sampledAtMonotonicMs) || input.sampledAtMonotonicMs < 0) {
        return {
          cpu: unavailableCpu(cpuState?.logicalProcessorCount ?? 0),
          memory: sampleMemory(runtime),
        };
      }
      cpuState = sampleCpu(runtime, cpuState, input.sampledAtMonotonicMs, input.platform);
      return {
        cpu: cpuState.metric,
        memory: sampleMemory(runtime),
      };
    },
  };
}
