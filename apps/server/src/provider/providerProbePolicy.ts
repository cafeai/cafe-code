import type { ServerProvider } from "@cafecode/contracts";

/**
 * Two isolated inconclusive probes retain a known-good provider presentation;
 * the third becomes visible. Keeping this policy in one server module ensures
 * the managed provider and the cache/registry merge boundary cannot disagree
 * after a backend restart.
 */
export const DEFAULT_PROVIDER_INCONCLUSIVE_FAILURE_THRESHOLD = 3;

/**
 * Compute a stable phase offset without exposing provider configuration. The
 * FNV-1a hash is not used as an identity or security primitive; it merely
 * prevents every same-interval provider instance from launching a CLI probe
 * at the same instant after startup.
 */
export const deterministicProviderProbePhaseOffsetMs = (
  instanceId: ServerProvider["instanceId"],
  intervalMs: number,
): number => {
  const boundedIntervalMs = Math.max(1, Math.floor(intervalMs));
  let hash = 0x811c9dc5;
  for (const character of instanceId) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % boundedIntervalMs;
};

export const hasConclusiveProviderAuthState = (snapshot: ServerProvider): boolean =>
  snapshot.auth.status !== "unknown" && snapshot.status !== "disabled";

/**
 * Preserve only the provider/auth presentation that an inconclusive probe
 * could not authoritatively replace. Fresh installation/version/model data
 * still lands, while account-scoped usage remains bound to the same retained
 * auth identity. The timeout's human-facing warning is deliberately omitted;
 * its classified occurrence remains visible in the redacted diagnostics.
 */
export const retainConclusiveProviderState = (
  previous: ServerProvider,
  inconclusive: ServerProvider,
): ServerProvider => {
  const {
    message: _inconclusiveMessage,
    accountRateLimits: _inconclusiveRateLimits,
    ...inconclusiveWithoutPresentation
  } = inconclusive;
  return {
    ...inconclusiveWithoutPresentation,
    status: previous.status,
    auth: previous.auth,
    // `checkedAt` describes the public status/auth assertion. Keep its last
    // conclusive timestamp; the separate probe diagnostics record exactly
    // when the inconclusive attempt ran and how long it took.
    checkedAt: previous.checkedAt,
    ...(previous.message ? { message: previous.message } : {}),
    ...(previous.accountRateLimits ? { accountRateLimits: previous.accountRateLimits } : {}),
  };
};

const saturatingNonNegativeIntAddition = (left: number, right: number): number =>
  Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, left) + Math.max(0, right));

const compareProbeTimestamps = (left: string | null, right: string | null): number => {
  if (left === right) {
    return 0;
  }
  if (left === null) {
    return -1;
  }
  if (right === null) {
    return 1;
  }

  // Contract timestamps are canonical ISO instants, so lexical ordering is
  // chronological and avoids accepting implementation-defined Date parsing.
  return left < right ? -1 : 1;
};

const isProbeObservationOlder = (
  previous: NonNullable<ServerProvider["probeDiagnostics"]>,
  next: NonNullable<ServerProvider["probeDiagnostics"]>,
): boolean => {
  const finishedOrder = compareProbeTimestamps(next.lastFinishedAt, previous.lastFinishedAt);
  if (finishedOrder !== 0) {
    return finishedOrder < 0;
  }
  return compareProbeTimestamps(next.lastStartedAt, previous.lastStartedAt) < 0;
};

/**
 * Preserve an inconclusive streak across managed-provider reconstruction.
 *
 * A provider's local `attemptCount` starts at zero whenever its owning scope is
 * rebuilt, while ProviderRegistry may still hold a cached last-known-good
 * presentation whose diagnostics ended with one or two inconclusive probes.
 * Without this reconciliation, repeatedly restarting Cafe could prevent the
 * bounded third-failure warning from ever becoming visible.
 *
 * Registry refreshes can deliver the same observation twice (once from the
 * direct refresh result and once from the provider change stream), so exact
 * duplicate timestamps preserve the already-merged streak instead of counting
 * it again. `attemptCount` deliberately remains the current provider scope's
 * raw counter. A streak larger than that counter records the carried prefix;
 * later observations in the same scope add only their newly observed delta.
 */
export const reconcileInconclusiveProviderProbeStreak = (
  previous: ServerProvider,
  next: ServerProvider,
): ServerProvider => {
  const previousDiagnostics = previous.probeDiagnostics;
  const nextDiagnostics = next.probeDiagnostics;
  if (!previousDiagnostics || !nextDiagnostics) {
    return next;
  }

  // A provider change stream and the direct refresh return are independent
  // delivery paths. Once a newer observation has landed, a delayed older one
  // is not evidence of a provider-scope reset and must not consume another
  // transient-failure allowance or regress the visible provider state.
  if (isProbeObservationOlder(previousDiagnostics, nextDiagnostics)) {
    return previous;
  }

  const isDuplicateObservation =
    previousDiagnostics.attemptCount === nextDiagnostics.attemptCount &&
    previousDiagnostics.lastStartedAt === nextDiagnostics.lastStartedAt &&
    previousDiagnostics.lastFinishedAt === nextDiagnostics.lastFinishedAt;
  let nextScheduledAt = nextDiagnostics.nextScheduledAt;
  // The first externally-admitted refresh can be observed through both its
  // direct return and two stream publications (probe, then schedule). If an
  // older schedule copy is delivered last, keep the latest target already
  // correlated to this exact observation and scheduler configuration. This
  // covers both the initial null target and a non-null pre-overrun target that
  // the fixed-rate scheduler advanced after a slow probe completed.
  if (
    isDuplicateObservation &&
    previousDiagnostics.nextScheduledAt !== null &&
    nextDiagnostics.periodicIntervalMs === previousDiagnostics.periodicIntervalMs &&
    nextDiagnostics.periodicPhaseOffsetMs === previousDiagnostics.periodicPhaseOffsetMs &&
    (nextScheduledAt === null ||
      compareProbeTimestamps(previousDiagnostics.nextScheduledAt, nextScheduledAt) > 0)
  ) {
    nextScheduledAt = previousDiagnostics.nextScheduledAt;
  }

  if (
    previousDiagnostics.lastOutcome !== "inconclusive" ||
    nextDiagnostics.lastOutcome !== "inconclusive"
  ) {
    return nextScheduledAt === nextDiagnostics.nextScheduledAt
      ? next
      : {
          ...next,
          probeDiagnostics: {
            ...nextDiagnostics,
            nextScheduledAt,
          },
        };
  }

  let consecutiveInconclusiveCount = nextDiagnostics.consecutiveInconclusiveCount;

  if (isDuplicateObservation) {
    consecutiveInconclusiveCount = Math.max(
      previousDiagnostics.consecutiveInconclusiveCount,
      nextDiagnostics.consecutiveInconclusiveCount,
    );
  } else if (nextDiagnostics.attemptCount <= previousDiagnostics.attemptCount) {
    consecutiveInconclusiveCount = saturatingNonNegativeIntAddition(
      previousDiagnostics.consecutiveInconclusiveCount,
      nextDiagnostics.consecutiveInconclusiveCount,
    );
  } else if (previousDiagnostics.consecutiveInconclusiveCount > previousDiagnostics.attemptCount) {
    consecutiveInconclusiveCount = saturatingNonNegativeIntAddition(
      previousDiagnostics.consecutiveInconclusiveCount,
      Math.max(0, nextDiagnostics.consecutiveInconclusiveCount - previousDiagnostics.attemptCount),
    );
  }

  if (
    consecutiveInconclusiveCount === nextDiagnostics.consecutiveInconclusiveCount &&
    nextScheduledAt === nextDiagnostics.nextScheduledAt
  ) {
    return next;
  }
  return {
    ...next,
    probeDiagnostics: {
      ...nextDiagnostics,
      consecutiveInconclusiveCount,
      nextScheduledAt,
    },
  };
};
