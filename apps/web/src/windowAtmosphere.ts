import {
  DEFAULT_FALLING_EFFECT_DENSITY,
  DEFAULT_FALLING_EFFECT_JAPANESE_RATIO,
  MAX_FALLING_EFFECT_DENSITY,
  MAX_FALLING_EFFECT_JAPANESE_RATIO,
  MAX_FALLING_EFFECT_SPEED,
  MIN_FALLING_EFFECT_DENSITY,
  MIN_FALLING_EFFECT_JAPANESE_RATIO,
  MIN_FALLING_EFFECT_SPEED,
  type AmbientColor,
  type FallingEffectKind,
  type FallingEffectMatrixColorMode,
} from "@cafecode/contracts/settings";

export const MAX_ATMOSPHERE_DPR = 2;
export const MAX_ATMOSPHERE_CANVAS_PIXELS = 8_388_608;
export const MAX_ATMOSPHERE_FRAME_DELTA_SECONDS = 0.1;
export const MATRIX_RAINBOW_CYCLE_MS = 18_000;
export const MAX_ATMOSPHERE_PARTICLES_BY_KIND = {
  snow: 320,
  rain: 440,
  matrix: 160,
} as const satisfies Record<FallingEffectKind, number>;

export const MATRIX_ROMAN_GLYPHS =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz@#$%&*+-=<>[]{}";
export const MATRIX_JAPANESE_CODING_AI_TERMS = [
  "電脳",
  "機械",
  "知能",
  "学習",
  "推論",
  "生成",
  "言語",
  "符号",
  "解析",
  "演算",
  "回路",
  "未来",
  "創造",
  "対話",
  "探索",
  "深層",
  "神経",
  "仮想",
  "現実",
  "夢",
  "夜",
  "光",
  "影",
  "零",
  "無限",
] as const;
export const MATRIX_JAPANESE_GLYPHS = `アイウエオカキクケコサシスセソタチツテトナニヌネノマミムメモヤユヨラリルレロワヲン${MATRIX_JAPANESE_CODING_AI_TERMS.join("")}`;

export interface AtmosphereParticle {
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  size: number;
  phase: number;
  glyphOffset: number;
  glyphs: string;
}

export interface AtmosphereScene {
  readonly kind: FallingEffectKind;
  readonly width: number;
  readonly height: number;
  readonly particles: AtmosphereParticle[];
}

export interface AtmosphereAnimationState {
  readonly enabled: boolean;
  readonly reducedMotion: boolean;
  readonly documentVisible: boolean;
  readonly windowFocused: boolean;
  readonly continueBackgroundAnimations: boolean;
}

export interface MatrixColorFrame {
  readonly color: string;
  readonly perStream: boolean;
  readonly baseHue: number | null;
  readonly saturation: number | null;
  readonly lightness: number | null;
}

export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function clampAtmosphereDpr(devicePixelRatio: number): number {
  if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) return 1;
  return Math.min(MAX_ATMOSPHERE_DPR, devicePixelRatio);
}

export function fitAtmosphereDpr(devicePixelRatio: number, width: number, height: number): number {
  const requestedDpr = clampAtmosphereDpr(devicePixelRatio);
  const safeWidth = Number.isFinite(width) ? Math.max(1, width) : 1;
  const safeHeight = Number.isFinite(height) ? Math.max(1, height) : 1;
  const cssPixels = safeWidth * safeHeight;
  return Math.min(requestedDpr, Math.sqrt(MAX_ATMOSPHERE_CANVAS_PIXELS / cssPixels));
}

export function clampFallingEffectSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 1;
  return Math.min(MAX_FALLING_EFFECT_SPEED, Math.max(MIN_FALLING_EFFECT_SPEED, speed));
}

export function clampFallingEffectDensity(density: number): number {
  if (!Number.isFinite(density)) return DEFAULT_FALLING_EFFECT_DENSITY;
  return Math.min(MAX_FALLING_EFFECT_DENSITY, Math.max(MIN_FALLING_EFFECT_DENSITY, density));
}

export function clampFallingEffectJapaneseRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_FALLING_EFFECT_JAPANESE_RATIO;
  return Math.min(
    MAX_FALLING_EFFECT_JAPANESE_RATIO,
    Math.max(MIN_FALLING_EFFECT_JAPANESE_RATIO, ratio),
  );
}

export function calculateAtmosphereParticleCount(
  kind: FallingEffectKind,
  width: number,
  height: number,
  requestedDensity = DEFAULT_FALLING_EFFECT_DENSITY,
): number {
  const safeWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  const safeHeight = Number.isFinite(height) ? Math.max(0, height) : 0;
  if (safeWidth === 0 || safeHeight === 0) return 0;
  const requested =
    kind === "matrix"
      ? Math.ceil(safeWidth / 24)
      : Math.ceil((safeWidth * safeHeight) / (kind === "rain" ? 10_000 : 14_000));
  const minimum = kind === "matrix" ? 12 : 24;
  return Math.min(
    MAX_ATMOSPHERE_PARTICLES_BY_KIND[kind],
    Math.max(minimum, Math.ceil(requested * clampFallingEffectDensity(requestedDensity))),
  );
}

export function createAtmosphereScene(
  kind: FallingEffectKind,
  width: number,
  height: number,
  random: () => number,
  density = DEFAULT_FALLING_EFFECT_DENSITY,
  japaneseRatio = DEFAULT_FALLING_EFFECT_JAPANESE_RATIO,
): AtmosphereScene {
  const safeWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  const safeHeight = Number.isFinite(height) ? Math.max(0, height) : 0;
  const count = calculateAtmosphereParticleCount(kind, safeWidth, safeHeight, density);
  const particles = Array.from({ length: count }, (_, index): AtmosphereParticle => {
    if (kind === "rain") {
      return {
        x: random() * safeWidth,
        y: random() * safeHeight,
        velocityX: -18 - random() * 18,
        velocityY: 360 + random() * 260,
        size: 10 + random() * 16,
        phase: random() * Math.PI * 2,
        glyphOffset: 0,
        glyphs: "",
      };
    }
    if (kind === "matrix") {
      const glyphs =
        random() < clampFallingEffectJapaneseRatio(japaneseRatio)
          ? MATRIX_JAPANESE_GLYPHS
          : MATRIX_ROMAN_GLYPHS;
      return {
        x: count > 0 ? ((index + 0.5) / count) * safeWidth : 0,
        y: random() * safeHeight,
        velocityX: 0,
        velocityY: 55 + random() * 85,
        size: 12 + Math.round(random() * 5),
        phase: random() * Math.PI * 2,
        glyphOffset: Math.floor(random() * glyphs.length),
        glyphs,
      };
    }
    return {
      x: random() * safeWidth,
      y: random() * safeHeight,
      velocityX: (random() - 0.5) * 18,
      velocityY: 18 + random() * 34,
      size: 1.5 + random() * 3,
      phase: random() * Math.PI * 2,
      glyphOffset: 0,
      glyphs: "",
    };
  });
  return { kind, width: safeWidth, height: safeHeight, particles };
}

export function advanceAtmosphereSceneInPlace(
  scene: AtmosphereScene,
  elapsedSeconds: number,
  requestedSpeed: number,
): void {
  const deltaSeconds = Number.isFinite(elapsedSeconds)
    ? Math.min(MAX_ATMOSPHERE_FRAME_DELTA_SECONDS, Math.max(0, elapsedSeconds))
    : 0;
  const speed = clampFallingEffectSpeed(requestedSpeed);
  for (const particle of scene.particles) {
    if (scene.kind === "snow") {
      particle.x +=
        (particle.velocityX + Math.sin(particle.phase + particle.y * 0.01) * 8) *
        deltaSeconds *
        speed;
    } else {
      particle.x += particle.velocityX * deltaSeconds * speed;
    }
    particle.y += particle.velocityY * deltaSeconds * speed;
    const horizontalMargin = scene.kind === "rain" ? particle.size : particle.size * 2;
    if (particle.x < -horizontalMargin) particle.x = scene.width + horizontalMargin;
    else if (particle.x > scene.width + horizontalMargin) particle.x = -horizontalMargin;
    const verticalMargin = scene.kind === "matrix" ? particle.size * 8 : particle.size * 2;
    if (particle.y > scene.height + verticalMargin) {
      particle.y = -verticalMargin - ((particle.phase * 37) % Math.max(1, scene.height * 0.2));
      if (scene.kind === "matrix") {
        particle.glyphOffset = (particle.glyphOffset + 17) % particle.glyphs.length;
      }
    }
  }
}

export function resolveAtmosphereColor(
  kind: FallingEffectKind,
  configuredColor: AmbientColor,
  darkTheme: boolean,
): string {
  if (configuredColor !== "auto") return configuredColor;
  if (kind === "matrix") return darkTheme ? "#4ade80" : "#15803d";
  if (kind === "rain") return darkTheme ? "#38bdf8" : "#0369a1";
  return darkTheme ? "#f8fafc" : "#64748b";
}

function wrapHue(hue: number): number {
  return ((hue % 360) + 360) % 360;
}

function hslColor(hue: number, saturation: number, lightness: number): string {
  return `hsl(${wrapHue(hue).toFixed(1)} ${saturation.toFixed(1)}% ${lightness.toFixed(1)}%)`;
}

export function resolveMatrixAtmosphereColorFrame(
  mode: FallingEffectMatrixColorMode,
  configuredColor: AmbientColor,
  darkTheme: boolean,
  timestamp: number,
): MatrixColorFrame {
  const fallback = resolveAtmosphereColor("matrix", configuredColor, darkTheme);
  if (mode === "fixed") {
    return { color: fallback, perStream: false, baseHue: null, saturation: null, lightness: null };
  }
  const safeTimestamp = Number.isFinite(timestamp) ? Math.max(0, timestamp) : 0;
  const hue = wrapHue((safeTimestamp / MATRIX_RAINBOW_CYCLE_MS) * 360);
  const saturation = 88;
  const lightness = darkTheme ? 62 : 40;
  return {
    color: hslColor(hue, saturation, lightness),
    perStream: mode === "rainbow-extra",
    baseHue: hue,
    saturation,
    lightness,
  };
}

export function resolveMatrixAtmosphereColor(
  mode: FallingEffectMatrixColorMode,
  configuredColor: AmbientColor,
  darkTheme: boolean,
  timestamp: number,
): string {
  return resolveMatrixAtmosphereColorFrame(mode, configuredColor, darkTheme, timestamp).color;
}

export function resolveMatrixStreamColor(
  frame: MatrixColorFrame,
  particle: AtmosphereParticle,
): string {
  if (
    !frame.perStream ||
    frame.baseHue === null ||
    frame.saturation === null ||
    frame.lightness === null
  ) {
    return frame.color;
  }
  return hslColor(
    frame.baseHue + (particle.phase / (Math.PI * 2)) * 360,
    frame.saturation,
    frame.lightness,
  );
}

export function shouldAnimateAtmosphere(state: AtmosphereAnimationState): boolean {
  if (!state.enabled || state.reducedMotion) return false;
  return state.continueBackgroundAnimations || (state.documentVisible && state.windowFocused);
}

export function drawAtmosphereScene(
  context: CanvasRenderingContext2D,
  scene: AtmosphereScene,
  color: string,
  opacity: number,
  matrixColorFrame?: MatrixColorFrame,
): void {
  context.clearRect(0, 0, scene.width, scene.height);
  const normalizedOpacity = Math.min(1, Math.max(0, opacity));
  if (normalizedOpacity === 0) return;

  context.save();
  context.fillStyle = color;
  context.strokeStyle = color;

  if (scene.kind === "snow") {
    context.globalAlpha = normalizedOpacity;
    for (const particle of scene.particles) {
      context.beginPath();
      context.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
      context.fill();
    }
  } else if (scene.kind === "rain") {
    context.globalAlpha = normalizedOpacity;
    context.lineCap = "round";
    for (const particle of scene.particles) {
      context.lineWidth = Math.max(0.75, particle.size / 12);
      context.beginPath();
      context.moveTo(particle.x, particle.y);
      context.lineTo(particle.x + particle.velocityX * 0.025, particle.y + particle.size);
      context.stroke();
    }
  } else {
    context.textAlign = "center";
    context.textBaseline = "middle";
    for (const particle of scene.particles) {
      context.fillStyle =
        matrixColorFrame === undefined
          ? color
          : resolveMatrixStreamColor(matrixColorFrame, particle);
      context.font = `${particle.size}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
      for (let trailIndex = 7; trailIndex >= 0; trailIndex -= 1) {
        const glyphIndex =
          (particle.glyphOffset +
            trailIndex * 7 +
            Math.floor(Math.max(0, particle.y) / particle.size)) %
          particle.glyphs.length;
        context.globalAlpha =
          trailIndex === 0 ? normalizedOpacity : normalizedOpacity * (1 - trailIndex / 8) * 0.7;
        context.fillText(
          particle.glyphs[glyphIndex] ?? "0",
          particle.x,
          particle.y - trailIndex * particle.size,
        );
      }
    }
  }

  context.restore();
}
