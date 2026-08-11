import { describe, expect, it } from "vitest";
import {
  MAX_ATMOSPHERE_CANVAS_PIXELS,
  MAX_ATMOSPHERE_FRAME_DELTA_SECONDS,
  MAX_ATMOSPHERE_PARTICLES_BY_KIND,
  MATRIX_JAPANESE_GLYPHS,
  MATRIX_RAINBOW_CYCLE_MS,
  MATRIX_ROMAN_GLYPHS,
  advanceAtmosphereSceneInPlace,
  calculateAtmosphereParticleCount,
  clampAtmosphereDpr,
  clampFallingEffectDensity,
  clampFallingEffectJapaneseRatio,
  clampFallingEffectSpeed,
  createAtmosphereScene,
  createSeededRandom,
  fitAtmosphereDpr,
  resolveAtmosphereColor,
  resolveMatrixAtmosphereColorFrame,
  resolveMatrixStreamColor,
  shouldAnimateAtmosphere,
} from "./windowAtmosphere";

describe("window atmosphere model", () => {
  it("creates deterministic bounded scenes for each effect", () => {
    for (const kind of ["snow", "rain", "matrix"] as const) {
      const first = createAtmosphereScene(kind, 1920, 1080, createSeededRandom(42));
      const second = createAtmosphereScene(kind, 1920, 1080, createSeededRandom(42));
      expect(first).toEqual(second);
      expect(first.particles.length).toBeLessThanOrEqual(MAX_ATMOSPHERE_PARTICLES_BY_KIND[kind]);
      expect(first.particles.length).toBeGreaterThan(0);
    }
    expect(calculateAtmosphereParticleCount("matrix", 100_000, 100_000, 2.5)).toBe(
      MAX_ATMOSPHERE_PARTICLES_BY_KIND.matrix,
    );
    expect(calculateAtmosphereParticleCount("snow", 0, 100)).toBe(0);
    expect(calculateAtmosphereParticleCount("snow", Number.NaN, 100)).toBe(0);
    expect(calculateAtmosphereParticleCount("rain", 100, Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("selects Roman and Japanese Matrix pools by the bounded ratio", () => {
    const roman = createAtmosphereScene("matrix", 320, 240, createSeededRandom(1), 1, 0);
    const japanese = createAtmosphereScene("matrix", 320, 240, createSeededRandom(1), 1, 1);
    expect(roman.particles.every((particle) => particle.glyphs === MATRIX_ROMAN_GLYPHS)).toBe(true);
    expect(japanese.particles.every((particle) => particle.glyphs === MATRIX_JAPANESE_GLYPHS)).toBe(
      true,
    );
  });

  it("clamps invalid display and motion inputs", () => {
    expect(clampAtmosphereDpr(Number.NaN)).toBe(1);
    expect(clampAtmosphereDpr(4)).toBe(2);
    const fitted = fitAtmosphereDpr(2, 8000, 4000);
    expect(fitted * fitted * 8000 * 4000).toBeLessThanOrEqual(MAX_ATMOSPHERE_CANVAS_PIXELS + 0.001);
    expect(fitAtmosphereDpr(2, Number.NaN, Number.POSITIVE_INFINITY)).toBe(2);
    expect(clampFallingEffectSpeed(Infinity)).toBe(1);
    expect(clampFallingEffectSpeed(0)).toBe(0.25);
    expect(clampFallingEffectDensity(Infinity)).toBe(1);
    expect(clampFallingEffectDensity(10)).toBe(2.5);
    expect(clampFallingEffectJapaneseRatio(Number.NaN)).toBe(0.45);
    expect(clampFallingEffectJapaneseRatio(2)).toBe(1);
  });

  it("bounds frame advancement and wraps Matrix streams", () => {
    const scene = createAtmosphereScene("matrix", 320, 100, createSeededRandom(7), 1, 0);
    const particle = scene.particles[0]!;
    const initialY = particle.y;
    advanceAtmosphereSceneInPlace(scene, 100, 1);
    expect(particle.y - initialY).toBeLessThanOrEqual(
      particle.velocityY * MAX_ATMOSPHERE_FRAME_DELTA_SECONDS,
    );
    particle.y = scene.height + particle.size * 8 + 1;
    const initialOffset = particle.glyphOffset;
    advanceAtmosphereSceneInPlace(scene, 0, 1);
    expect(particle.y).toBeLessThan(0);
    expect(particle.glyphOffset).toBe((initialOffset + 17) % particle.glyphs.length);
  });

  it("normalizes invalid scene geometry and ignores non-finite frame deltas", () => {
    const scene = createAtmosphereScene(
      "matrix",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      createSeededRandom(3),
    );
    expect(scene).toEqual({ kind: "matrix", width: 0, height: 0, particles: [] });

    const validScene = createAtmosphereScene("snow", 320, 200, createSeededRandom(4));
    const before = structuredClone(validScene.particles);
    advanceAtmosphereSceneInPlace(validScene, Number.NaN, 1);
    expect(validScene.particles).toEqual(before);
  });

  it("resolves theme defaults and deterministic Matrix palettes", () => {
    expect(resolveAtmosphereColor("snow", "auto", true)).toBe("#f8fafc");
    expect(resolveAtmosphereColor("rain", "auto", false)).toBe("#0369a1");
    expect(resolveAtmosphereColor("matrix", "#123456", true)).toBe("#123456");

    const fixed = resolveMatrixAtmosphereColorFrame("fixed", "auto", true, 100);
    expect(fixed).toEqual({
      color: "#4ade80",
      perStream: false,
      baseHue: null,
      saturation: null,
      lightness: null,
    });
    expect(resolveMatrixAtmosphereColorFrame("rainbow", "auto", true, 0).color).toBe(
      "hsl(0.0 88.0% 62.0%)",
    );
    expect(
      resolveMatrixAtmosphereColorFrame("rainbow", "auto", true, MATRIX_RAINBOW_CYCLE_MS).color,
    ).toBe("hsl(0.0 88.0% 62.0%)");
    const extra = resolveMatrixAtmosphereColorFrame("rainbow-extra", "auto", false, 4500);
    expect(extra.perStream).toBe(true);
    const particle = createAtmosphereScene("matrix", 320, 200, createSeededRandom(9)).particles[0]!;
    expect(resolveMatrixStreamColor(extra, particle)).not.toBe(extra.color);
  });

  it("pauses unless visibility policy allows animation", () => {
    expect(
      shouldAnimateAtmosphere({
        enabled: true,
        reducedMotion: false,
        documentVisible: true,
        windowFocused: true,
        continueBackgroundAnimations: false,
      }),
    ).toBe(true);
    expect(
      shouldAnimateAtmosphere({
        enabled: true,
        reducedMotion: false,
        documentVisible: false,
        windowFocused: false,
        continueBackgroundAnimations: true,
      }),
    ).toBe(true);
    expect(
      shouldAnimateAtmosphere({
        enabled: true,
        reducedMotion: true,
        documentVisible: true,
        windowFocused: true,
        continueBackgroundAnimations: true,
      }),
    ).toBe(false);
  });
});
