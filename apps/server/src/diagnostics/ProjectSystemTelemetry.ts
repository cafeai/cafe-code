import { performance } from "node:perf_hooks";

import type {
  ProjectId,
  ServerProjectSystemTelemetryResult,
  ServerSystemCpuTelemetry,
  ServerSystemMemoryTelemetry,
} from "@cafecode/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  makeHostSystemTelemetrySampler,
  makeLiveHostSystemTelemetryRuntime,
  type HostSystemTelemetrySample,
  type HostSystemTelemetrySamplerShape,
} from "./HostSystemTelemetry.ts";
import {
  makeProjectVolumeProbeProcess,
  type ProjectVolumeProbeProcessShape,
} from "./ProjectVolumeProbeProcess.ts";
import {
  makeProjectVolumeSampler,
  type ProjectVolumeSamplerShape,
} from "./ProjectVolumeSampler.ts";
import { unavailableProjectVolumeTelemetry } from "./ProjectVolumeTelemetry.ts";

export const PROJECT_SYSTEM_TELEMETRY_MINIMUM_SAMPLE_INTERVAL_MS = 1_000;

const PROJECT_CACHE_RETENTION_MS = 30_000;
const MAX_CACHED_PROJECTS = 64;
const UNKNOWN_RUNTIME_LABEL = "unknown";

interface CachedProjectSample {
  readonly workspaceRoot: string;
  readonly sampledAtMonotonicMs: number;
  readonly generation: number;
  readonly result: ServerProjectSystemTelemetryResult;
}

interface InFlightProjectSample {
  readonly workspaceRoot: string;
  readonly generation: number;
  readonly pending: Promise<ServerProjectSystemTelemetryResult>;
}

export interface ProjectSystemTelemetryRuntime {
  readonly nowMillis: () => number;
  readonly nowMonotonicMillis: () => number;
  readonly platform: () => string;
  readonly architecture: () => string;
}

export interface ProjectSystemTelemetryDependencies {
  readonly hostSampler: HostSystemTelemetrySamplerShape;
  readonly volumeSampler: ProjectVolumeSamplerShape;
  readonly runtime: ProjectSystemTelemetryRuntime;
}

export interface ProjectSystemTelemetryShape {
  readonly read: (input: {
    readonly projectId: ProjectId;
    readonly workspaceRoot: string;
  }) => Effect.Effect<ServerProjectSystemTelemetryResult>;
}

export class ProjectSystemTelemetry extends Context.Service<
  ProjectSystemTelemetry,
  ProjectSystemTelemetryShape
>()("cafecode/diagnostics/ProjectSystemTelemetry") {}

function unavailableHostSample(): HostSystemTelemetrySample {
  const cpu: ServerSystemCpuTelemetry = {
    status: "unavailable",
    utilizationPercent: null,
    logicalProcessorCount: 0,
    detail: "CPU telemetry is unavailable.",
  };
  const memory: ServerSystemMemoryTelemetry = {
    status: "unavailable",
    totalBytes: null,
    usedBytes: null,
    availableBytes: null,
    utilizationPercent: null,
    detail: "Memory telemetry is unavailable.",
  };
  return { cpu, memory };
}

function safeClock(read: () => number, fallback: () => number): number {
  try {
    const value = read();
    return Number.isFinite(value) && value >= 0 ? value : fallback();
  } catch {
    return fallback();
  }
}

function safeRuntimeLabel(read: () => string): string {
  try {
    const value = read().trim();
    return value.length > 0 ? value : UNKNOWN_RUNTIME_LABEL;
  } catch {
    return UNKNOWN_RUNTIME_LABEL;
  }
}

function pruneProjectCache(
  projects: Map<ProjectId, CachedProjectSample>,
  sampledAtMonotonicMs: number,
): void {
  for (const [projectId, sample] of projects) {
    if (
      sampledAtMonotonicMs < sample.sampledAtMonotonicMs ||
      sampledAtMonotonicMs - sample.sampledAtMonotonicMs > PROJECT_CACHE_RETENTION_MS
    ) {
      projects.delete(projectId);
    }
  }
  while (projects.size > MAX_CACHED_PROJECTS) {
    const oldest = [...projects.entries()].toSorted(
      ([, left], [, right]) =>
        left.sampledAtMonotonicMs - right.sampledAtMonotonicMs ||
        left.generation - right.generation,
    )[0];
    if (!oldest) return;
    projects.delete(oldest[0]);
  }
}

/**
 * Combine host and exact-project volume samples without accepting a renderer path.
 *
 * The caller must resolve `workspaceRoot` from the server's project projection.
 * Cache identity includes both the branded project ID and that authoritative
 * root, so moving a project cannot reuse a sample from its former volume.
 */
export function makeProjectSystemTelemetry(
  dependencies: ProjectSystemTelemetryDependencies,
): ProjectSystemTelemetryShape {
  const projectCache = new Map<ProjectId, CachedProjectSample>();
  const inFlightProjects = new Map<ProjectId, InFlightProjectSample>();
  let nextGeneration = 0;

  const readPromise = (input: {
    readonly projectId: ProjectId;
    readonly workspaceRoot: string;
  }): Promise<ServerProjectSystemTelemetryResult> => {
    const sampledAtMonotonicMs = safeClock(
      dependencies.runtime.nowMonotonicMillis,
      performance.now.bind(performance),
    );
    pruneProjectCache(projectCache, sampledAtMonotonicMs);

    const cached = projectCache.get(input.projectId);
    if (
      cached?.workspaceRoot === input.workspaceRoot &&
      sampledAtMonotonicMs >= cached.sampledAtMonotonicMs &&
      sampledAtMonotonicMs - cached.sampledAtMonotonicMs <
        PROJECT_SYSTEM_TELEMETRY_MINIMUM_SAMPLE_INTERVAL_MS
    ) {
      return Promise.resolve(cached.result);
    }

    const inFlight = inFlightProjects.get(input.projectId);
    if (inFlight?.workspaceRoot === input.workspaceRoot) {
      return inFlight.pending;
    }

    nextGeneration += 1;
    const generation = nextGeneration;
    const sampledAtMs = safeClock(dependencies.runtime.nowMillis, Date.now);
    const platform = safeRuntimeLabel(dependencies.runtime.platform);
    const architecture = safeRuntimeLabel(dependencies.runtime.architecture);
    let host: HostSystemTelemetrySample;
    try {
      host = dependencies.hostSampler.sample({ sampledAtMonotonicMs, platform });
    } catch {
      host = unavailableHostSample();
    }

    const pending = Promise.resolve()
      .then(() => dependencies.volumeSampler.read(input.workspaceRoot))
      .then(
        (projectVolume) => ({
          projectId: input.projectId,
          sampledAt: DateTime.makeUnsafe(sampledAtMs),
          minimumSampleIntervalMs: PROJECT_SYSTEM_TELEMETRY_MINIMUM_SAMPLE_INTERVAL_MS,
          platform,
          architecture,
          cpu: host.cpu,
          memory: host.memory,
          projectVolume,
        }),
        () => ({
          projectId: input.projectId,
          sampledAt: DateTime.makeUnsafe(sampledAtMs),
          minimumSampleIntervalMs: PROJECT_SYSTEM_TELEMETRY_MINIMUM_SAMPLE_INTERVAL_MS,
          platform,
          architecture,
          cpu: host.cpu,
          memory: host.memory,
          projectVolume: unavailableProjectVolumeTelemetry(),
        }),
      )
      .then((result) => {
        const current = projectCache.get(input.projectId);
        if (current && current.generation > generation) {
          // A project can move while a slow volume read is in flight. Never
          // hand the old-root sample back after a newer generation has won.
          return current.result;
        }
        projectCache.set(input.projectId, {
          workspaceRoot: input.workspaceRoot,
          sampledAtMonotonicMs,
          generation,
          result,
        });
        pruneProjectCache(projectCache, sampledAtMonotonicMs);
        return result;
      });

    inFlightProjects.set(input.projectId, {
      workspaceRoot: input.workspaceRoot,
      generation,
      pending,
    });
    void pending.then(
      () => {
        if (inFlightProjects.get(input.projectId)?.generation === generation) {
          inFlightProjects.delete(input.projectId);
        }
      },
      () => {
        if (inFlightProjects.get(input.projectId)?.generation === generation) {
          inFlightProjects.delete(input.projectId);
        }
      },
    );
    return pending;
  };

  return ProjectSystemTelemetry.of({
    read: (input) => Effect.promise(() => readPromise(input)),
  });
}

function makeLiveRuntime(): ProjectSystemTelemetryRuntime {
  return {
    nowMillis: Date.now,
    nowMonotonicMillis: performance.now.bind(performance),
    platform: () => process.platform,
    architecture: () => process.arch,
  };
}

function makeLiveService(probe: ProjectVolumeProbeProcessShape): ProjectSystemTelemetryShape {
  const runtime = makeLiveRuntime();
  return makeProjectSystemTelemetry({
    hostSampler: makeHostSystemTelemetrySampler(makeLiveHostSystemTelemetryRuntime()),
    volumeSampler: makeProjectVolumeSampler(probe, {
      nowMonotonicMillis: runtime.nowMonotonicMillis,
    }),
    runtime,
  });
}

const liveService = Effect.acquireRelease(Effect.sync(makeProjectVolumeProbeProcess), (probe) =>
  Effect.promise(() => probe.close()),
).pipe(Effect.map(makeLiveService));

export const layer = Layer.effect(ProjectSystemTelemetry, liveService);
