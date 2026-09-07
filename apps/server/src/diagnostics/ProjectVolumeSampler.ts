import { performance } from "node:perf_hooks";

import type { ServerProjectVolumeTelemetry } from "@cafecode/contracts";

import {
  type ProjectVolumeReader,
  projectVolumeMetricFromCounters,
  unavailableProjectVolumeTelemetry,
} from "./ProjectVolumeTelemetry.ts";

export const PROJECT_VOLUME_MINIMUM_SAMPLE_INTERVAL_MS = 10_000;
export const PROJECT_VOLUME_SAMPLE_TIMEOUT_MS = 2_000;
export const PROJECT_VOLUME_WATCHDOG_GRACE_MS = 2_250;
export const PROJECT_VOLUME_MAX_IN_FLIGHT_READS = 8;
export const PROJECT_VOLUME_RETRY_COOLDOWN_MS = 30_000;
export const PROJECT_VOLUME_MAX_CACHED_ROOTS = 64;

const MAX_READER_TIMEOUT_MS = 60_000;
const MAX_WATCHDOG_GRACE_MS = 60_000;
const MAX_RETRY_COOLDOWN_MS = 86_400_000;

interface CachedVolumeSample {
  readonly sampledAtMonotonicMs: number;
  readonly generation: number;
  readonly metric: ServerProjectVolumeTelemetry;
}

interface InFlightVolumeSample {
  readonly generation: number;
  readonly pending: Promise<ServerProjectVolumeTelemetry>;
}

interface RetryCooldown {
  readonly failedAtMonotonicMs: number;
  readonly generation: number;
}

export interface ProjectVolumeSamplerClock {
  readonly nowMonotonicMillis: () => number;
}

export interface ProjectVolumeSamplerOptions {
  readonly minimumSampleIntervalMs?: number;
  readonly sampleTimeoutMs?: number;
  readonly watchdogGraceMs?: number;
  readonly retryCooldownMs?: number;
  readonly maxInFlightReads?: number;
  readonly maxCachedRoots?: number;
}

export interface ProjectVolumeSamplerShape {
  readonly read: (workspaceRoot: string) => Promise<ServerProjectVolumeTelemetry>;
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 && value <= maximum
    ? value
    : fallback;
}

function monotonicNow(clock: ProjectVolumeSamplerClock): number {
  try {
    const value = clock.nowMonotonicMillis();
    return Number.isFinite(value) && value >= 0 ? value : performance.now();
  } catch {
    return performance.now();
  }
}

function pruneOldest<T extends { readonly generation: number }>(
  entries: Map<string, T>,
  maximumEntries: number,
  sampledAt: (entry: T) => number,
): void {
  while (entries.size > maximumEntries) {
    const oldest = [...entries.entries()].toSorted(
      ([, left], [, right]) =>
        sampledAt(left) - sampledAt(right) || left.generation - right.generation,
    )[0];
    if (!oldest) return;
    entries.delete(oldest[0]);
  }
}

function awaitWithWatchdog(
  pending: Promise<ServerProjectVolumeTelemetry>,
  watchdogMs: number,
): Promise<ServerProjectVolumeTelemetry> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (metric: ServerProjectVolumeTelemetry) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(metric);
    };
    const deadline = setTimeout(() => {
      settle(unavailableProjectVolumeTelemetry());
    }, watchdogMs);
    void pending.then(settle, () => settle(unavailableProjectVolumeTelemetry()));
  });
}

/**
 * Build a bounded project-volume sample coordinator.
 *
 * Waiter watchdogs never cancel or release an admitted native operation. The
 * reader owns termination and resource release; admission is held until that
 * operation settles. Only actual operation failure starts retry cooldown.
 */
export function makeProjectVolumeSampler(
  reader: ProjectVolumeReader,
  clock: ProjectVolumeSamplerClock,
  options: ProjectVolumeSamplerOptions = {},
): ProjectVolumeSamplerShape {
  const minimumSampleIntervalMs = boundedPositiveInteger(
    options.minimumSampleIntervalMs,
    PROJECT_VOLUME_MINIMUM_SAMPLE_INTERVAL_MS,
    MAX_RETRY_COOLDOWN_MS,
  );
  const sampleTimeoutMs = boundedPositiveInteger(
    options.sampleTimeoutMs,
    PROJECT_VOLUME_SAMPLE_TIMEOUT_MS,
    MAX_READER_TIMEOUT_MS,
  );
  const watchdogGraceMs = boundedPositiveInteger(
    options.watchdogGraceMs,
    PROJECT_VOLUME_WATCHDOG_GRACE_MS,
    MAX_WATCHDOG_GRACE_MS,
  );
  const retryCooldownMs = boundedPositiveInteger(
    options.retryCooldownMs,
    PROJECT_VOLUME_RETRY_COOLDOWN_MS,
    MAX_RETRY_COOLDOWN_MS,
  );
  const maxInFlightReads = boundedPositiveInteger(
    options.maxInFlightReads,
    PROJECT_VOLUME_MAX_IN_FLIGHT_READS,
    PROJECT_VOLUME_MAX_IN_FLIGHT_READS,
  );
  const maxCachedRoots = boundedPositiveInteger(
    options.maxCachedRoots,
    PROJECT_VOLUME_MAX_CACHED_ROOTS,
    PROJECT_VOLUME_MAX_CACHED_ROOTS,
  );
  const watchdogMs = sampleTimeoutMs + watchdogGraceMs;

  const cachedSamples = new Map<string, CachedVolumeSample>();
  const inFlightSamples = new Map<string, InFlightVolumeSample>();
  const retryCooldowns = new Map<string, RetryCooldown>();
  let nextGeneration = 0;

  const cacheAvailableSample = (
    workspaceRoot: string,
    generation: number,
    metric: ServerProjectVolumeTelemetry,
  ) => {
    const current = cachedSamples.get(workspaceRoot);
    if (current && current.generation > generation) {
      return;
    }
    cachedSamples.set(workspaceRoot, {
      sampledAtMonotonicMs: monotonicNow(clock),
      generation,
      metric,
    });
    pruneOldest(cachedSamples, maxCachedRoots, (sample) => sample.sampledAtMonotonicMs);
  };

  const startCooldown = (workspaceRoot: string, generation: number) => {
    const current = retryCooldowns.get(workspaceRoot);
    if (current && current.generation > generation) {
      return;
    }
    retryCooldowns.set(workspaceRoot, {
      failedAtMonotonicMs: monotonicNow(clock),
      generation,
    });
    pruneOldest(retryCooldowns, maxCachedRoots, (cooldown) => cooldown.failedAtMonotonicMs);
  };

  const getCached = (
    workspaceRoot: string,
    sampledAtMonotonicMs: number,
  ): ServerProjectVolumeTelemetry | null => {
    const cached = cachedSamples.get(workspaceRoot);
    if (!cached) return null;
    if (
      sampledAtMonotonicMs < cached.sampledAtMonotonicMs ||
      sampledAtMonotonicMs - cached.sampledAtMonotonicMs >= minimumSampleIntervalMs
    ) {
      cachedSamples.delete(workspaceRoot);
      return null;
    }
    return cached.metric;
  };

  const isCoolingDown = (workspaceRoot: string, sampledAtMonotonicMs: number): boolean => {
    const cooldown = retryCooldowns.get(workspaceRoot);
    if (!cooldown) return false;
    if (
      sampledAtMonotonicMs < cooldown.failedAtMonotonicMs ||
      sampledAtMonotonicMs - cooldown.failedAtMonotonicMs >= retryCooldownMs
    ) {
      retryCooldowns.delete(workspaceRoot);
      return false;
    }
    return true;
  };

  const getOrStart = (workspaceRoot: string): Promise<ServerProjectVolumeTelemetry> | null => {
    const existing = inFlightSamples.get(workspaceRoot);
    if (existing) {
      return existing.pending;
    }

    const sampledAtMonotonicMs = monotonicNow(clock);
    const cached = getCached(workspaceRoot, sampledAtMonotonicMs);
    if (cached) {
      return Promise.resolve(cached);
    }
    if (
      isCoolingDown(workspaceRoot, sampledAtMonotonicMs) ||
      inFlightSamples.size >= maxInFlightReads
    ) {
      return null;
    }

    nextGeneration += 1;
    const generation = nextGeneration;
    const pending = Promise.resolve()
      .then(() => reader.read(workspaceRoot, sampleTimeoutMs))
      .then(
        (counters) => {
          const metric = projectVolumeMetricFromCounters(counters);
          if (metric.status === "available") {
            retryCooldowns.delete(workspaceRoot);
            cacheAvailableSample(workspaceRoot, generation, metric);
          } else {
            startCooldown(workspaceRoot, generation);
          }
          return metric;
        },
        () => {
          startCooldown(workspaceRoot, generation);
          return unavailableProjectVolumeTelemetry();
        },
      );
    inFlightSamples.set(workspaceRoot, { generation, pending });
    const release = () => {
      if (inFlightSamples.get(workspaceRoot)?.pending === pending) {
        inFlightSamples.delete(workspaceRoot);
      }
    };
    // Use both `then` branches instead of an ignored `finally()` derivative:
    // even an unexpected internal rejection must not become unhandled.
    void pending.then(release, release);
    return pending;
  };

  const read = async (workspaceRoot: string): Promise<ServerProjectVolumeTelemetry> => {
    if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
      return unavailableProjectVolumeTelemetry();
    }
    const pending = getOrStart(workspaceRoot);
    return pending
      ? awaitWithWatchdog(pending, watchdogMs)
      : Promise.resolve(unavailableProjectVolumeTelemetry());
  };

  return { read };
}
