import type { ServerProvider } from "@cafecode/contracts";

/**
 * Debug snapshots cross the renderer/main-process boundary and are retained in
 * a short history. Keep this fleet view deliberately small and allowlisted:
 * provider snapshots can also contain account labels, emails, commands, paths,
 * model inventories, skills, and package-manager output that do not belong in
 * an ordinary operational diagnostic.
 */
export const DEBUG_PROVIDER_SUMMARY_LIMIT = 64;

export function summarizeProviderDebugFleet(providers: ReadonlyArray<ServerProvider>) {
  const sortedProviders = providers.toSorted((left, right) => {
    const instanceOrder = left.instanceId.localeCompare(right.instanceId);
    return instanceOrder !== 0 ? instanceOrder : left.driver.localeCompare(right.driver);
  });
  const includedProviders = sortedProviders.slice(0, DEBUG_PROVIDER_SUMMARY_LIMIT);

  return {
    totalCount: sortedProviders.length,
    includedCount: includedProviders.length,
    omittedCount: Math.max(0, sortedProviders.length - includedProviders.length),
    limit: DEBUG_PROVIDER_SUMMARY_LIMIT,
    instances: includedProviders.map((provider) => ({
      instanceId: provider.instanceId,
      driver: provider.driver,
      enabled: provider.enabled,
      installed: provider.installed,
      version: provider.version,
      status: provider.status,
      availability: provider.availability ?? "available",
      checkedAt: provider.checkedAt,
      update:
        provider.updateState === undefined
          ? null
          : {
              status: provider.updateState.status,
              startedAt: provider.updateState.startedAt,
              finishedAt: provider.updateState.finishedAt,
            },
      probePhases: (provider.probePhases ?? []).map((phase) => ({
        phase: phase.phase,
        outcome: phase.outcome,
        durationMs: phase.durationMs,
      })),
      probe:
        provider.probeDiagnostics === undefined
          ? null
          : {
              attemptCount: provider.probeDiagnostics.attemptCount,
              consecutiveInconclusiveCount: provider.probeDiagnostics.consecutiveInconclusiveCount,
              lastOutcome: provider.probeDiagnostics.lastOutcome,
              lastStartedAt: provider.probeDiagnostics.lastStartedAt,
              lastFinishedAt: provider.probeDiagnostics.lastFinishedAt,
              lastDurationMs: provider.probeDiagnostics.lastDurationMs,
              periodicIntervalMs: provider.probeDiagnostics.periodicIntervalMs,
              periodicPhaseOffsetMs: provider.probeDiagnostics.periodicPhaseOffsetMs,
              nextScheduledAt: provider.probeDiagnostics.nextScheduledAt,
            },
    })),
  };
}
