export const SCHEMA_VERSION = 10;

export const GOLDEN_RATIO = (1 + Math.sqrt(5)) / 2;
export const SILVER_RATIO = 1 + Math.sqrt(2);

export const RATIO_PRESETS = Object.freeze({
  unity: { label: "Physical 1:1", factor: 1 },
  "golden-minor": { label: "Golden compact · 1/φ", factor: 1 / GOLDEN_RATIO },
  "golden-major": { label: "Golden grand · φ", factor: GOLDEN_RATIO },
  "silver-minor": { label: "Silver compact · 1/δₛ", factor: 1 / SILVER_RATIO },
  "silver-major": { label: "Silver grand · δₛ", factor: SILVER_RATIO },
  "root-two": { label: "Diagonal · √2", factor: Math.sqrt(2) },
  "root-three": { label: "Hexagonal · √3", factor: Math.sqrt(3) },
});

export const MATERIALS = Object.freeze({
  glass: { label: "Glass smooth", roughness: 0.04, specular: 1, grain: 0.02 },
  satin: { label: "Satin", roughness: 0.28, specular: 0.68, grain: 0.045 },
  granite: { label: "Granite", roughness: 0.7, specular: 0.27, grain: 0.22 },
  sandstone: { label: "Sandstone", roughness: 0.88, specular: 0.12, grain: 0.16 },
  concrete: { label: "Polished concrete", roughness: 0.48, specular: 0.43, grain: 0.11 },
});

export const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  enabled: true,
  renderer: "auto",
  quality: "cinematic",
  continueBackgroundAnimations: false,
  alignmentMode: "seamless",
  ratioPreset: "unity",
  ratioLockOnResize: true,
  displayDiagonalInches: 48,
  tripletLongSpanInches: 0.5,
  manualCssPixelsPerInch: 0,
  tessellationMode: "rhombille",
  material: "glass",
  tileBase: "white",
  customDiamondColorsEnabled: false,
  diamondColorA: "#f2efe3",
  diamondColorB: "#f2efe3",
  diamondColorC: "#f2efe3",
  colorPattern: "facet",
  patternScale: 1,
  patternPhase: 0,
  patternRotation: 0,
  patternMirror: false,
  foregroundIllumination: 0.82,
  gapWidth: 0.035,
  separationAmount: 0.16,
  separationFrequency: 0.12,
  separationCycle: true,
  emberPulse: true,
  emberIntensity: 0.48,
  emberPattern: "organic",
  emberColorA: "#8c0601",
  emberColorB: "#ff7a09",
  pistonMode: "radial",
  pistonAmplitude: 0.72,
  pitDepth: 6,
  pistonSpeed: 0.18,
  perspectiveStrength: 0.55,
  facetRelief: 0.11,
  facetReliefSpeed: 0.12,
  pointerAttractionEnabled: true,
  pointerLightDepthEnabled: true,

  behindLightEnabled: true,
  behindLightType: "point-bar",
  behindLightMotion: "orbit",
  behindLightColor: "#21e6d1",
  behindWhiteTemperatureKelvin: 7200,
  behindLightIntensity: 1.35,
  behindLightRadius: 0.28,
  behindLightBeamWidth: 1,
  behindLightFanout: 0,
  behindLightSpeed: 0.16,
  behindLightFixedX: 0.5,
  behindLightFixedY: 0.5,
  behindRainbowCycle: false,
  behindRainbowSpeed: 0.25,
  behindPrismStrength: 2.4,
  behindPrismMode: "neon",

  frontLightEnabled: true,
  frontLightType: "point",
  frontLightMotion: "pointer",
  frontLightColor: "#86fff2",
  frontWhiteTemperatureKelvin: 6800,
  frontLightIntensity: 1.1,
  frontLightRadius: 0.34,
  frontLightBeamWidth: 1,
  frontLightFanout: 0,
  frontLightSpeed: 0.12,
  frontLightFixedX: 0.5,
  frontLightFixedY: 0.42,
  frontRainbowCycle: false,
  frontRainbowSpeed: 0.2,
  frontPrismStrength: 1.8,
  frontPrismMode: "neon",

  gapParticles: "cycling",
  meshEnergyColor: "#21e6d1",
  meshEnergyRainbowCycle: false,
  meshEnergyRainbowSpeed: 0.25,
  particleCount: 360,
  particleSpeed: 0.34,
  particleSpeedVariation: 0.55,

  fallingEffectsEnabled: true,
  fallingSourceProfile: "club-code",
  fallingEffectKind: "matrix",
  fallingMotion: "flat",
  fallingOpacity: 0.35,
  fallingSpeed: 1,
  fallingDensity: 1,
  fallingScale: 1,
  fallingWind: 0,
  fallingTrail: 8,
  fallingAutoColor: true,
  fallingColor: "#4ade80",
  fallingColorMode: "fixed",
  fallingColorCycleSpeed: 1,
  fallingJapaneseRatio: 0.45,
  fallingMatrixBaseFontSize: 14,
  fallingReflectionEnabled: true,
  reflectionIntensity: 0.26,

  reducedMotion: "system",
  seed: 0x48455833,
});

export const PROFILE_PRESENTATION_KEYS = Object.freeze(
  Object.keys(DEFAULT_SETTINGS).filter(
    (key) => !["schemaVersion", "enabled", "renderer", "reducedMotion", "fallingEffectsEnabled"].includes(key),
  ),
);

export const ACTIVATION_KEYS = Object.freeze(["enabled", "fallingEffectsEnabled"]);

const ENUMS = {
  renderer: ["auto", "gpu", "canvas"],
  quality: ["performance", "balanced", "cinematic"],
  alignmentMode: ["seamless", "whole-tiles"],
  ratioPreset: Object.keys(RATIO_PRESETS),
  tessellationMode: ["rhombille", "cairo-pentagon", "hexagram"],
  material: Object.keys(MATERIALS),
  tileBase: ["white", "dark"],
  colorPattern: ["facet", "backyard-star", "rotating-triplets", "checker", "rings", "seeded-mosaic"],
  emberPattern: ["organic", "rings", "hexagon", "star"],
  pistonMode: ["off", "radial", "wave", "pit"],
  behindLightType: ["point", "point-bar", "bar", "laser", "ripple", "total"],
  frontLightType: ["point", "point-bar", "bar", "laser", "ripple", "total"],
  behindLightMotion: ["pointer", "fixed", "orbit", "wander"],
  frontLightMotion: ["pointer", "fixed", "orbit", "wander"],
  behindPrismMode: ["neon", "white-core", "white-fringe", "solid"],
  frontPrismMode: ["neon", "white-core", "white-fringe", "solid"],
  gapParticles: ["off", "constant", "cycling"],
  fallingSourceProfile: ["club-code", "jobsearch"],
  fallingEffectKind: ["matrix", "rain", "snow"],
  fallingMotion: ["flat", "forward", "reverse", "tunnel", "walk-forward", "walk-reverse"],
  fallingColorMode: ["fixed", "rainbow", "rainbow-extra"],
  reducedMotion: ["system", "always", "never"],
};

const NUMBER_BOUNDS = {
  displayDiagonalInches: [10, 120],
  tripletLongSpanInches: [0.12, 4],
  manualCssPixelsPerInch: [0, 400],
  patternScale: [1, 12],
  patternPhase: [0, 5],
  patternRotation: [0, 5],
  foregroundIllumination: [0, 1],
  gapWidth: [0, 0.18],
  separationAmount: [0, 0.42],
  separationFrequency: [0, 1],
  emberIntensity: [0, 1.5],
  pistonAmplitude: [0, 1.5],
  pitDepth: [0.5, 12],
  pistonSpeed: [0, 2],
  perspectiveStrength: [0, 1.5],
  facetRelief: [0, 0.5],
  facetReliefSpeed: [0, 2],
  behindWhiteTemperatureKelvin: [1800, 12000],
  behindLightIntensity: [0, 24],
  behindLightRadius: [0.01, 1.5],
  behindLightBeamWidth: [0.05, 5],
  behindLightFanout: [0, 3],
  behindLightSpeed: [0, 5],
  behindLightFixedX: [-0.5, 1.5],
  behindLightFixedY: [-0.5, 1.5],
  behindRainbowSpeed: [0.02, 64],
  behindPrismStrength: [0, 12],
  frontWhiteTemperatureKelvin: [1800, 12000],
  frontLightIntensity: [0, 24],
  frontLightRadius: [0.01, 1.5],
  frontLightBeamWidth: [0.05, 5],
  frontLightFanout: [0, 3],
  frontLightSpeed: [0, 5],
  frontLightFixedX: [-0.5, 1.5],
  frontLightFixedY: [-0.5, 1.5],
  frontRainbowSpeed: [0.02, 64],
  frontPrismStrength: [0, 12],
  particleCount: [0, 20000],
  meshEnergyRainbowSpeed: [0.02, 64],
  particleSpeed: [0, 4],
  particleSpeedVariation: [0, 1],
  fallingOpacity: [0.05, 1],
  fallingSpeed: [0.25, 4],
  fallingDensity: [0.5, 10],
  fallingScale: [0.25, 9],
  fallingWind: [-2, 2],
  fallingTrail: [1, 64],
  fallingColorCycleSpeed: [0.25, 64],
  fallingJapaneseRatio: [0, 1],
  fallingMatrixBaseFontSize: [1, 72],
  reflectionIntensity: [0, 1],
  seed: [0, 0xffffffff],
};

const BOOLEAN_KEYS = new Set([
  "enabled", "continueBackgroundAnimations", "ratioLockOnResize", "separationCycle", "customDiamondColorsEnabled",
  "emberPulse", "pointerAttractionEnabled", "pointerLightDepthEnabled", "behindLightEnabled", "behindRainbowCycle",
  "frontLightEnabled", "frontRainbowCycle", "fallingEffectsEnabled", "fallingAutoColor",
  "fallingReflectionEnabled", "meshEnergyRainbowCycle", "patternMirror",
]);

const COLOR_KEYS = ["diamondColorA", "diamondColorB", "diamondColorC", "emberColorA", "emberColorB", "behindLightColor", "frontLightColor", "meshEnergyColor", "fallingColor"];
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

function migrateLegacySettings(input) {
  const migrated = { ...input };
  const sourceSchemaVersion = Number.isInteger(input.schemaVersion) ? input.schemaVersion : 1;
  if (sourceSchemaVersion <= 8 && input.colorPattern === "backyard-star") migrated.colorPattern = "rotating-triplets";
  const copy = (legacy, targets) => {
    if (input[legacy] === undefined) return;
    for (const target of targets) if (input[target] === undefined) migrated[target] = input[legacy];
  };
  copy("lightType", ["behindLightType", "frontLightType"]);
  copy("lightColor", ["behindLightColor", "frontLightColor"]);
  copy("whiteTemperatureKelvin", ["behindWhiteTemperatureKelvin", "frontWhiteTemperatureKelvin"]);
  copy("lightIntensity", ["behindLightIntensity", "frontLightIntensity"]);
  copy("lightSpeed", ["behindLightSpeed", "frontLightSpeed"]);
  copy("rainbowCycle", ["behindRainbowCycle", "frontRainbowCycle"]);
  copy("rainbowSpeed", ["behindRainbowSpeed", "frontRainbowSpeed"]);
  copy("prismStrength", ["behindPrismStrength", "frontPrismStrength"]);
  copy("prismMode", ["behindPrismMode", "frontPrismMode"]);
  copy("useDiamondColors", ["customDiamondColorsEnabled"]);
  copy("tileColorA", ["diamondColorA"]);
  copy("tileColorB", ["diamondColorB"]);
  copy("tileColorC", ["diamondColorC"]);
  copy("lightFanout", ["behindLightFanout", "frontLightFanout"]);
  copy("particleColor", ["meshEnergyColor"]);
  copy("meshColor", ["meshEnergyColor"]);
  copy("particleRainbowCycle", ["meshEnergyRainbowCycle"]);
  copy("particleRainbowSpeed", ["meshEnergyRainbowSpeed"]);
  copy("pistonPointerResponse", ["pointerAttractionEnabled", "pointerLightDepthEnabled"]);
  if (input.interactivePointer === true) migrated.frontLightMotion ??= "pointer";
  if (input.interactivePointer === false) migrated.frontLightMotion ??= "orbit";
  if (input.reflectionEffect && input.reflectionEffect !== "off") {
    migrated.fallingEffectKind ??= input.reflectionEffect === "glyphs" ? "matrix" : input.reflectionEffect;
    migrated.fallingReflectionEnabled ??= true;
  }
  return migrated;
}

export function normalizeSettings(input = {}) {
  const source = migrateLegacySettings(input);
  const output = { ...DEFAULT_SETTINGS };
  for (const [key, allowed] of Object.entries(ENUMS)) {
    if (allowed.includes(source[key])) output[key] = source[key];
  }
  for (const [key, [minimum, maximum]] of Object.entries(NUMBER_BOUNDS)) {
    const numeric = Number(source[key]);
    if (Number.isFinite(numeric)) output[key] = clamp(numeric, minimum, maximum);
  }
  output.particleCount = Math.round(output.particleCount);
  output.fallingTrail = Math.round(output.fallingTrail);
  output.fallingMatrixBaseFontSize = Math.round(output.fallingMatrixBaseFontSize);
  output.patternScale = Math.round(output.patternScale);
  output.patternPhase = Math.round(output.patternPhase);
  output.patternRotation = Math.round(output.patternRotation);
  output.seed = Math.round(output.seed) >>> 0;
  for (const key of BOOLEAN_KEYS) {
    if (typeof source[key] === "boolean") output[key] = source[key];
  }
  for (const key of COLOR_KEYS) {
    if (/^#[0-9a-f]{6}$/i.test(String(source[key] ?? ""))) output[key] = String(source[key]).toLowerCase();
  }
  return output;
}

export function presentationProfile(settings) {
  const normalized = normalizeSettings(settings);
  return Object.fromEntries(PROFILE_PRESENTATION_KEYS.map((key) => [key, normalized[key]]));
}

export function settingsAffectGeometry(previous, next) {
  return ["alignmentMode", "ratioPreset", "ratioLockOnResize", "displayDiagonalInches", "tessellationMode",
    "tripletLongSpanInches", "manualCssPixelsPerInch", "quality", "seed"]
    .some((key) => previous[key] !== next[key]);
}

export function settingsAffectFallingScene(previous, next) {
  return ["fallingSourceProfile", "fallingEffectKind", "fallingDensity", "fallingScale",
    "fallingJapaneseRatio", "fallingMotion", "quality", "seed"]
    .some((key) => previous[key] !== next[key]);
}

export function qualityLimits(quality) {
  if (quality === "performance") return { dpr: 1, backingPixels: 3_000_000, tiles: 3200, meshParticles: 4000, reflections: 4096 };
  if (quality === "balanced") return { dpr: 1.5, backingPixels: 5_000_000, tiles: 5600, meshParticles: 10000, reflections: 8192 };
  return { dpr: 2, backingPixels: 8_388_608, tiles: 8192, meshParticles: 20000, reflections: 16384 };
}
