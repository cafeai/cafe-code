import { describe, expect, it } from "vitest";

import { glowColorFromPixels } from "./sidebarGlow";

function pixels(...colors: ReadonlyArray<readonly [number, number, number, number?]>) {
  return Uint8ClampedArray.from(colors.flatMap(([r, g, b, a = 255]) => [r, g, b, a]));
}

function repeat(count: number, color: readonly [number, number, number, number?]) {
  return Array.from({ length: count }, () => color);
}

function parseGlow(glow: string | null) {
  const match = /^oklch\(0\.62 ([\d.]+) ([\d.]+)\)$/u.exec(glow ?? "");
  if (!match?.[1] || !match[2]) throw new Error(`Unexpected glow ${glow}`);
  return { chroma: Number(match[1]), hue: Number(match[2]) };
}

describe("glowColorFromPixels", () => {
  it("keeps the accent for grey pictures", () => {
    expect(glowColorFromPixels(pixels([30, 30, 30], [128, 128, 128], [240, 240, 240]))).toBeNull();
  });

  it("ignores transparent pixels", () => {
    expect(glowColorFromPixels(pixels(...repeat(4, [220, 30, 30, 0])))).toBeNull();
  });

  it("follows the picture's hue with a gentle chroma", () => {
    // A dull reddish-brown sketch, like a pencil drawing on brown paper.
    const glow = parseGlow(glowColorFromPixels(pixels(...repeat(16, [74, 53, 48]))));
    expect(glow.hue).toBeGreaterThan(15);
    expect(glow.hue).toBeLessThan(55);
    expect(glow.chroma).toBeGreaterThanOrEqual(0.07);
    expect(glow.chroma).toBeLessThanOrEqual(0.15);
  });

  it("lets a small coloured subject outweigh a larger grey background", () => {
    const glow = parseGlow(
      glowColorFromPixels(pixels(...repeat(12, [40, 40, 42]), ...repeat(4, [20, 120, 230]))),
    );
    // OKLCH blue sits near hue 250.
    expect(glow.hue).toBeGreaterThan(220);
    expect(glow.hue).toBeLessThan(280);
  });
});
