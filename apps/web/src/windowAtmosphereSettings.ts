import {
  DEFAULT_AMBIENT_OPACITY,
  DEFAULT_FALLING_EFFECT_DENSITY,
  DEFAULT_FALLING_EFFECT_JAPANESE_RATIO,
  DEFAULT_FALLING_EFFECT_SPEED,
  MAX_AMBIENT_OPACITY,
  MAX_FALLING_EFFECT_DENSITY,
  MAX_FALLING_EFFECT_JAPANESE_RATIO,
  MAX_FALLING_EFFECT_SPEED,
  MIN_AMBIENT_OPACITY,
  MIN_FALLING_EFFECT_DENSITY,
  MIN_FALLING_EFFECT_JAPANESE_RATIO,
  MIN_FALLING_EFFECT_SPEED,
} from "@cafecode/contracts/settings";

export function clampAtmosphereSpeedSetting(value: number | null): number {
  if (value === null || !Number.isFinite(value)) return DEFAULT_FALLING_EFFECT_SPEED;
  return Math.min(MAX_FALLING_EFFECT_SPEED, Math.max(MIN_FALLING_EFFECT_SPEED, value));
}

export function clampAtmosphereDensitySetting(value: number | null): number {
  if (value === null || !Number.isFinite(value)) return DEFAULT_FALLING_EFFECT_DENSITY;
  return Math.min(MAX_FALLING_EFFECT_DENSITY, Math.max(MIN_FALLING_EFFECT_DENSITY, value));
}

export function clampAtmosphereJapanesePercentSetting(value: number | null): number {
  if (value === null || !Number.isFinite(value)) return DEFAULT_FALLING_EFFECT_JAPANESE_RATIO;
  return Math.min(
    MAX_FALLING_EFFECT_JAPANESE_RATIO,
    Math.max(MIN_FALLING_EFFECT_JAPANESE_RATIO, value / 100),
  );
}

export function clampAtmosphereOpacityPercentSetting(value: number | null): number {
  if (value === null || !Number.isFinite(value)) return DEFAULT_AMBIENT_OPACITY;
  return Math.min(MAX_AMBIENT_OPACITY, Math.max(MIN_AMBIENT_OPACITY, value / 100));
}
