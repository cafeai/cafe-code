import type { UsageStatsSnapshot } from "@cafecode/contracts";
import {
  MAX_FALLING_EFFECT_DENSITY,
  MAX_FALLING_EFFECT_SPEED,
  type FallingEffectKind,
} from "@cafecode/contracts/settings";

/** A short leaky window smooths provider usage reports that arrive in coarse bursts. */
export const ATMOSPHERE_USAGE_ACTIVITY_DECAY_MS = 5_000;
export const ATMOSPHERE_USAGE_FULL_SCALE_TOKENS_PER_SECOND = 30;
export const ATMOSPHERE_USAGE_MAX_SPEED_MULTIPLIER = 3;
export const ATMOSPHERE_USAGE_MAX_DENSITY_MULTIPLIER = 2.5;
const MAX_ACTIVITY_TOKEN_BUCKET = 20_000;

export interface AtmosphereUsageActivityState {
  lastTotalOutputTokens: number | null;
  lastUpdatedAtMs: number | null;
  activeSessionCount: number;
  tokenBucket: number;
}

export interface AtmosphereUsageActivity {
  readonly activeSessionCount: number;
  readonly intensity: number;
  readonly tokensPerSecond: number;
}

export interface AtmosphereUsageModulation {
  readonly activeParticleCount: number;
  readonly speed: number;
}

export function createAtmosphereUsageActivityState(): AtmosphereUsageActivityState {
  return {
    lastTotalOutputTokens: null,
    lastUpdatedAtMs: null,
    activeSessionCount: 0,
    tokenBucket: 0,
  };
}

function normalizedNow(nowMs: number): number {
  return Number.isFinite(nowMs) && nowMs >= 0 ? nowMs : 0;
}

function decayActivityInPlace(state: AtmosphereUsageActivityState, nowMs: number): void {
  const now = normalizedNow(nowMs);
  if (state.lastUpdatedAtMs === null) {
    state.lastUpdatedAtMs = now;
    return;
  }
  const elapsedMs = Math.max(0, now - state.lastUpdatedAtMs);
  if (elapsedMs > 0) {
    state.tokenBucket *= Math.exp(-elapsedMs / ATMOSPHERE_USAGE_ACTIVITY_DECAY_MS);
    if (state.tokenBucket < 0.001) state.tokenBucket = 0;
    state.lastUpdatedAtMs = now;
  }
}

export function resetAtmosphereUsageActivity(
  state: AtmosphereUsageActivityState,
  nowMs: number,
): void {
  state.lastTotalOutputTokens = null;
  state.lastUpdatedAtMs = normalizedNow(nowMs);
  state.activeSessionCount = 0;
  state.tokenBucket = 0;
}

/**
 * Admit only the global numeric usage snapshot. The initial lifetime total is
 * a baseline, never a burst, and a server reset cannot create synthetic work.
 */
export function observeAtmosphereUsageSnapshot(
  state: AtmosphereUsageActivityState,
  snapshot: UsageStatsSnapshot,
  nowMs: number,
): void {
  decayActivityInPlace(state, nowMs);
  const totalOutputTokens = Math.max(0, snapshot.totals.outputTokens);
  if (!snapshot.collectionEnabled) {
    state.lastTotalOutputTokens = totalOutputTokens;
    state.activeSessionCount = 0;
    state.tokenBucket = 0;
    return;
  }

  const previousTotal = state.lastTotalOutputTokens;
  if (previousTotal !== null && totalOutputTokens >= previousTotal) {
    state.tokenBucket = Math.min(
      MAX_ACTIVITY_TOKEN_BUCKET,
      state.tokenBucket + (totalOutputTokens - previousTotal),
    );
  }
  state.lastTotalOutputTokens = totalOutputTokens;
  state.activeSessionCount = Math.max(0, snapshot.activeSessionCount);
}

export function readAtmosphereUsageActivity(
  state: AtmosphereUsageActivityState,
  nowMs: number,
): AtmosphereUsageActivity {
  decayActivityInPlace(state, nowMs);
  const tokensPerSecond = state.tokenBucket / (ATMOSPHERE_USAGE_ACTIVITY_DECAY_MS / 1_000);
  const intensity =
    tokensPerSecond <= 0
      ? 0
      : tokensPerSecond / (tokensPerSecond + ATMOSPHERE_USAGE_FULL_SCALE_TOKENS_PER_SECOND);
  return {
    activeSessionCount: state.activeSessionCount,
    intensity,
    tokensPerSecond,
  };
}

export function resolveUsageReactiveCapacityDensity(baseDensity: number): number {
  if (!Number.isFinite(baseDensity)) return 1;
  return Math.min(
    MAX_FALLING_EFFECT_DENSITY,
    Math.max(0, baseDensity) * ATMOSPHERE_USAGE_MAX_DENSITY_MULTIPLIER,
  );
}

export function resolveAtmosphereUsageModulation(input: {
  readonly baseParticleCount: number;
  readonly baseSpeed: number;
  readonly capacityParticleCount: number;
  readonly enabled: boolean;
  readonly intensity: number;
  readonly kind: FallingEffectKind;
}): AtmosphereUsageModulation {
  const baseParticleCount = Math.max(0, Math.floor(input.baseParticleCount));
  const capacityParticleCount = Math.max(
    baseParticleCount,
    Math.floor(input.capacityParticleCount),
  );
  if (!input.enabled || input.kind === "matrix") {
    return {
      activeParticleCount: baseParticleCount,
      speed: Math.min(MAX_FALLING_EFFECT_SPEED, Math.max(0, input.baseSpeed)),
    };
  }

  const intensity = Number.isFinite(input.intensity)
    ? Math.min(1, Math.max(0, input.intensity))
    : 0;
  return {
    activeParticleCount: Math.round(
      baseParticleCount + (capacityParticleCount - baseParticleCount) * intensity,
    ),
    speed: Math.min(
      MAX_FALLING_EFFECT_SPEED,
      Math.max(0, input.baseSpeed) * (1 + (ATMOSPHERE_USAGE_MAX_SPEED_MULTIPLIER - 1) * intensity),
    ),
  };
}
