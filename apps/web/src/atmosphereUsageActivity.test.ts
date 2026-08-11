import { describe, expect, it } from "vitest";

import {
  ATMOSPHERE_USAGE_ACTIVITY_DECAY_MS,
  createAtmosphereUsageActivityState,
  observeAtmosphereUsageSnapshot,
  readAtmosphereUsageActivity,
  resetAtmosphereUsageActivity,
  resolveAtmosphereUsageModulation,
  resolveUsageReactiveCapacityDensity,
} from "./atmosphereUsageActivity";

function snapshot(outputTokens: number, activeSessionCount = 1, collectionEnabled = true) {
  return {
    totals: { generatingMs: 0, outputTokens, userMessages: 0 },
    today: { day: "2026-08-09", generatingMs: 0, outputTokens, userMessages: 0 },
    activeSessionCount,
    collectionEnabled,
    asOfMs: 0,
  } as const;
}

describe("atmosphere usage activity", () => {
  it("uses the initial lifetime count only as a baseline", () => {
    const state = createAtmosphereUsageActivityState();
    observeAtmosphereUsageSnapshot(state, snapshot(50_000), 1_000);

    expect(readAtmosphereUsageActivity(state, 1_000)).toEqual({
      activeSessionCount: 1,
      intensity: 0,
      tokensPerSecond: 0,
    });
  });

  it("combines aggregate token deltas and decays smoothly after output stops", () => {
    const state = createAtmosphereUsageActivityState();
    observeAtmosphereUsageSnapshot(state, snapshot(100, 2), 0);
    observeAtmosphereUsageSnapshot(state, snapshot(350, 3), 1_000);

    const active = readAtmosphereUsageActivity(state, 1_000);
    expect(active.activeSessionCount).toBe(3);
    expect(active.tokensPerSecond).toBe(50);
    expect(active.intensity).toBeCloseTo(0.625, 6);

    const decayed = readAtmosphereUsageActivity(state, 1_000 + ATMOSPHERE_USAGE_ACTIVITY_DECAY_MS);
    expect(decayed.tokensPerSecond).toBeCloseTo(50 / Math.E, 6);
    expect(decayed.intensity).toBeLessThan(active.intensity);
  });

  it("fails quiet when collection is disabled or the counter resets", () => {
    const state = createAtmosphereUsageActivityState();
    observeAtmosphereUsageSnapshot(state, snapshot(100), 0);
    observeAtmosphereUsageSnapshot(state, snapshot(300), 1_000);
    observeAtmosphereUsageSnapshot(state, snapshot(300, 0, false), 1_100);
    expect(readAtmosphereUsageActivity(state, 1_100).tokensPerSecond).toBe(0);

    observeAtmosphereUsageSnapshot(state, snapshot(10), 1_200);
    expect(readAtmosphereUsageActivity(state, 1_200).tokensPerSecond).toBe(0);
    resetAtmosphereUsageActivity(state, 1_300);
    expect(readAtmosphereUsageActivity(state, 1_300).activeSessionCount).toBe(0);
  });

  it("modulates only rain and snow within the reviewed renderer limits", () => {
    expect(resolveUsageReactiveCapacityDensity(1)).toBe(2.5);
    expect(resolveUsageReactiveCapacityDensity(10)).toBe(2.5);

    expect(
      resolveAtmosphereUsageModulation({
        baseParticleCount: 40,
        baseSpeed: 1,
        capacityParticleCount: 100,
        enabled: true,
        intensity: 0.5,
        kind: "rain",
      }),
    ).toEqual({ activeParticleCount: 70, speed: 2 });
    expect(
      resolveAtmosphereUsageModulation({
        baseParticleCount: 40,
        baseSpeed: 3,
        capacityParticleCount: 100,
        enabled: true,
        intensity: 1,
        kind: "snow",
      }),
    ).toEqual({ activeParticleCount: 100, speed: 4 });
    expect(
      resolveAtmosphereUsageModulation({
        baseParticleCount: 40,
        baseSpeed: 1,
        capacityParticleCount: 100,
        enabled: true,
        intensity: 1,
        kind: "matrix",
      }),
    ).toEqual({ activeParticleCount: 40, speed: 1 });
  });
});
