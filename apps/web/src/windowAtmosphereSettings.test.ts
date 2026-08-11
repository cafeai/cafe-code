import { describe, expect, it } from "vitest";

import {
  clampAtmosphereDensitySetting,
  clampAtmosphereJapanesePercentSetting,
  clampAtmosphereOpacityPercentSetting,
  clampAtmosphereSpeedSetting,
} from "./windowAtmosphereSettings";

describe("window atmosphere settings", () => {
  it("uses defaults for absent and non-finite values", () => {
    expect(clampAtmosphereSpeedSetting(null)).toBe(1);
    expect(clampAtmosphereDensitySetting(Number.NaN)).toBe(1);
    expect(clampAtmosphereJapanesePercentSetting(Infinity)).toBe(0.45);
    expect(clampAtmosphereOpacityPercentSetting(null)).toBe(0.35);
  });

  it("clamps speed and density to their contracts", () => {
    expect(clampAtmosphereSpeedSetting(0)).toBe(0.25);
    expect(clampAtmosphereSpeedSetting(10)).toBe(4);
    expect(clampAtmosphereDensitySetting(0)).toBe(0.5);
    expect(clampAtmosphereDensitySetting(10)).toBe(2.5);
  });

  it("converts bounded percentages to ratios", () => {
    expect(clampAtmosphereJapanesePercentSetting(-10)).toBe(0);
    expect(clampAtmosphereJapanesePercentSetting(65)).toBe(0.65);
    expect(clampAtmosphereJapanesePercentSetting(200)).toBe(1);
    expect(clampAtmosphereOpacityPercentSetting(0)).toBe(0.05);
    expect(clampAtmosphereOpacityPercentSetting(70)).toBe(0.7);
    expect(clampAtmosphereOpacityPercentSetting(200)).toBe(1);
  });
});
