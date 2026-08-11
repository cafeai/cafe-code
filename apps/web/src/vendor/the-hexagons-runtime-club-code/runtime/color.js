const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

export function hexToRgb(value) {
  const match = /^#([0-9a-f]{6})$/i.exec(String(value));
  if (!match) return [0.13, 0.9, 0.82];
  const numeric = Number.parseInt(match[1], 16);
  return [((numeric >> 16) & 255) / 255, ((numeric >> 8) & 255) / 255, (numeric & 255) / 255];
}

export function kelvinToRgb(kelvin) {
  const temperature = clamp(Number(kelvin) || 6500, 1000, 40000) / 100;
  let red;
  let green;
  let blue;
  if (temperature <= 66) {
    red = 255;
    green = 99.4708025861 * Math.log(temperature) - 161.1195681661;
    blue = temperature <= 19 ? 0 : 138.5177312231 * Math.log(temperature - 10) - 305.0447927307;
  } else {
    red = 329.698727446 * (temperature - 60) ** -0.1332047592;
    green = 288.1221695283 * (temperature - 60) ** -0.0755148492;
    blue = 255;
  }
  return [red, green, blue].map((channel) => clamp(channel, 0, 255) / 255);
}

export function hslToRgb(hue, saturation = 1, lightness = 0.5) {
  const h = ((hue % 360) + 360) % 360 / 360;
  if (saturation === 0) return [lightness, lightness, lightness];
  const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  const channel = (offset) => {
    let t = h + offset;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [channel(1 / 3), channel(0), channel(-1 / 3)];
}

export function meshEnergyColor(time, settings) {
  if (!settings.meshEnergyRainbowCycle) return hexToRgb(settings.meshEnergyColor);
  return hslToRgb((Number(time) || 0) * settings.meshEnergyRainbowSpeed * 60);
}

export function diamondTileColors(settings) {
  return [settings.diamondColorA, settings.diamondColorB, settings.diamondColorC].map(hexToRgb);
}

const ROYGBIP_HUES = [0, 0.075, 0.155, 0.36, 0.60, 0.71, 0.82];

function neonHueToRgb(hue) {
  const sector = ((hue % 1) + 1) % 1 * 6;
  const index = Math.floor(sector);
  const fraction = sector - index;
  return [[1,fraction,0],[1-fraction,1,0],[0,1,fraction],[0,1-fraction,1],[fraction,0,1],[1,0,1-fraction]][index];
}

export function visibleSpectrumToRgb(position) {
  const scaled = clamp(Number(position) || 0, 0, 1) * (ROYGBIP_HUES.length - 1);
  const segment = Math.min(Math.floor(scaled), ROYGBIP_HUES.length - 2);
  const amount = scaled - segment;
  const hue = ROYGBIP_HUES[segment] + (ROYGBIP_HUES[segment + 1] - ROYGBIP_HUES[segment]) * amount;
  return neonHueToRgb(hue);
}

const smoothstep = (edge0, edge1, value) => {
  const normalized = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return normalized * normalized * (3 - 2 * normalized);
};

export function spectralBeamColor(normalizedDistance, prismStrength, neutral = [1, 1, 1], prismMode = "neon") {
  const distance = Number(normalizedDistance) || 0;
  const prismAmount = clamp((Number(prismStrength) || 0) / 12, 0, 1);
  const spectralWindow = 1 - smoothstep(0.96, 1.34, Math.abs(distance));
  let spectralAmount = smoothstep(0, 0.15, prismAmount) * spectralWindow;
  if (prismMode === "white-core") {
    const whiteCore = 1 - smoothstep(0.05, 0.36, Math.abs(distance));
    spectralAmount *= 1 - whiteCore * 0.96;
  } else if (prismMode === "white-fringe") {
    const fringe = smoothstep(0.34, 0.62, Math.abs(distance)) * (1 - smoothstep(0.95, 1.24, Math.abs(distance)));
    spectralAmount *= fringe;
  }
  const spectrum = visibleSpectrumToRgb(clamp(0.5 + distance * 0.5 / 0.82, 0, 1));
  return neutral.map((channel, index) => channel + (spectrum[index] - channel) * spectralAmount);
}

export function spectralBeamOpacity(normalizedDistance, prismStrength) {
  const distance = Number(normalizedDistance) || 0;
  const prismAmount = clamp((Number(prismStrength) || 0) / 12, 0, 1);
  const spectralWindow = 1 - smoothstep(0.96, 1.34, Math.abs(distance));
  return 1 + (spectralWindow - 1) * prismAmount;
}
