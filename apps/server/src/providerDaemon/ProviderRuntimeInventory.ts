import {
  PROVIDER_DAEMON_HEALTH_PATH,
  ProviderDaemonHealth,
  type ProviderDaemonUpstreamSupervisorHealth,
  type ProviderDaemonQualificationSummary,
  type ServerProvider,
} from "@cafecode/contracts";
import { requestProviderDaemonJson } from "@cafecode/shared/providerDaemonHttp";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { performance } from "node:perf_hooks";

import { ServerConfig } from "../config.ts";
import { ProviderAdapterRegistry } from "../provider/Services/ProviderAdapterRegistry.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";

const decodeProviderDaemonHealthJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(ProviderDaemonHealth),
);

class ProviderRuntimeInventoryError extends Data.TaggedError("ProviderRuntimeInventoryError")<{
  readonly cause: unknown;
}> {}

export interface ProviderRuntimeInventorySnapshot {
  readonly configuredInstanceCount: number;
  readonly providerQualification?: ProviderDaemonQualificationSummary | undefined;
  readonly upstreamSupervisor?: ProviderDaemonUpstreamSupervisorHealth | undefined;
}

export interface ProviderRuntimeInventoryShape {
  readonly snapshot: Effect.Effect<ProviderRuntimeInventorySnapshot>;
}

export class ProviderRuntimeInventory extends Context.Service<
  ProviderRuntimeInventory,
  ProviderRuntimeInventoryShape
>()("cafecode/providerDaemon/ProviderRuntimeInventory") {}

/** Aggregate only existing owner observations; this never proves native support. */
export function summarizeProviderQualification(
  providers: ReadonlyArray<ServerProvider>,
): ProviderDaemonQualificationSummary {
  return {
    versionKnownCount: providers.filter((provider) => provider.version !== null).length,
    versionUnknownCount: providers.filter((provider) => provider.version === null).length,
    pendingCount: providers.filter(
      (provider) => provider.probeDiagnostics?.lastOutcome === "pending",
    ).length,
  };
}

function sanitizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Forward only authenticated supervisor identity on Windows. It is evidence
 * for selecting the supervisor's own fenced ownership transaction, never a
 * grant to signal the copied PID. The daemon and supervisor guards must remain
 * separate so shutdown cannot deadlock two profile ownership transactions.
 */
export function windowsSupervisorOwnershipMetadata(
  health: ProviderDaemonHealth,
  platform: NodeJS.Platform = process.platform,
): Pick<ProviderDaemonUpstreamSupervisorHealth, "windowsOwnershipId" | "windowsProcessIdentity"> {
  if (platform !== "win32") return {};
  return {
    ...(health.windowsProcessIdentity === undefined
      ? {}
      : { windowsProcessIdentity: health.windowsProcessIdentity }),
    ...(health.windowsOwnershipId === undefined
      ? {}
      : { windowsOwnershipId: health.windowsOwnershipId }),
  };
}

export const ProviderRuntimeInventoryLocalLive = Layer.effect(
  ProviderRuntimeInventory,
  Effect.gen(function* () {
    const providerAdapterRegistry = yield* ProviderAdapterRegistry;
    // Optional for legacy/synthetic inventory consumers. The production local
    // owner provides its own volatile status registry through the same layer
    // graph. Never fetch backend status or initiate a probe from health reads.
    const statusRegistry = yield* Effect.serviceOption(ProviderRegistry);
    return {
      snapshot: Effect.gen(function* () {
        const instances = yield* providerAdapterRegistry.listInstances();
        if (Option.isNone(statusRegistry)) {
          return { configuredInstanceCount: instances.length };
        }
        const providers = yield* statusRegistry.value.getProviders;
        return {
          configuredInstanceCount: instances.length,
          providerQualification: summarizeProviderQualification(providers),
        };
      }),
    } satisfies ProviderRuntimeInventoryShape;
  }),
);

export const ProviderRuntimeInventoryRemoteSupervisorLive = Layer.effect(
  ProviderRuntimeInventory,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    return {
      snapshot: Effect.gen(function* () {
        const endpoint = config.providerSupervisor;
        if (endpoint === undefined) {
          return {
            configuredInstanceCount: 0,
            upstreamSupervisor: {
              configured: false,
              reachable: false,
            },
          } satisfies ProviderRuntimeInventorySnapshot;
        }

        const startedAtMs = performance.now();
        const healthResult = yield* Effect.tryPromise({
          try: async () => {
            const response = await requestProviderDaemonJson(
              endpoint,
              PROVIDER_DAEMON_HEALTH_PATH,
              {
                timeoutMs: 5_000,
              },
            );
            if (response.statusCode < 200 || response.statusCode >= 300) {
              throw new Error(`provider supervisor health failed with HTTP ${response.statusCode}`);
            }
            const health = decodeProviderDaemonHealthJson(response.body);
            if (health.mode !== "provider-supervisor") {
              throw new Error(`provider supervisor endpoint reported mode ${health.mode}`);
            }
            return health;
          },
          catch: (cause) => new ProviderRuntimeInventoryError({ cause }),
        }).pipe(Effect.result);
        const healthLatencyMs = Math.round((performance.now() - startedAtMs) * 100) / 100;

        if (healthResult._tag === "Failure") {
          return {
            configuredInstanceCount: 0,
            upstreamSupervisor: {
              configured: true,
              reachable: false,
              endpointTransport: endpoint.transport ?? "tcp",
              healthLatencyMs,
              lastError: sanitizeError(healthResult.failure),
            },
          } satisfies ProviderRuntimeInventorySnapshot;
        }

        const health = healthResult.success;
        return {
          configuredInstanceCount: health.configuredInstanceCount,
          upstreamSupervisor: {
            configured: true,
            reachable: true,
            endpointTransport: endpoint.transport ?? "tcp",
            pid: health.pid,
            ppid: health.ppid,
            mode: health.mode,
            protocolVersion: health.protocolVersion,
            version: health.version,
            runtimeBuildId: health.runtimeBuildId,
            ...windowsSupervisorOwnershipMetadata(health),
            startedAt: health.startedAt,
            activeSessionCount: health.activeSessionCount,
            configuredInstanceCount: health.configuredInstanceCount,
            eventCursor: health.eventCursor,
            activeStreamCount: health.activeStreamCount,
            retainedEventCount: health.retainedEventCount,
            oldestEventCursor: health.oldestEventCursor,
            newestEventCursor: health.newestEventCursor,
            leaseCount: health.leaseCount,
            commandCount: health.commandCount,
            completedCommandCount: health.completedCommandCount,
            failedCommandCount: health.failedCommandCount,
            runningCommandCount: health.runningCommandCount,
            recentCompletedCommands: health.recentCompletedCommands,
            recentRunningCommands: health.recentRunningCommands,
            recentFailedCommands: health.recentFailedCommands,
            persistence: health.persistence,
            healthLatencyMs,
          },
        } satisfies ProviderRuntimeInventorySnapshot;
      }),
    } satisfies ProviderRuntimeInventoryShape;
  }),
);
