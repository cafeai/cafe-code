/**
 * OKLab/OKLCH conversions for `#rrggbb` colours, using Björn Ottosson's
 * transforms (https://bottosson.github.io/posts/oklab/). OKLCH lightness and
 * chroma track how bright and colourful a colour looks, so adjusting them keeps
 * a colour's hue steady in a way raw RGB or HSL arithmetic does not.
 */

export interface Oklch {
  /** Perceived lightness, 0 (black) to 1 (white). */
  readonly l: number;
  /** Colourfulness; sRGB colours stay below about 0.33. */
  readonly c: number;
  /** Hue in degrees. */
  readonly h: number;
}

const HEX_COLOR_PATTERN = /^#([0-9a-f]{6})$/iu;

function srgbChannelToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function linearChannelToSrgb(channel: number): number {
  return channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
}

/** OKLab `[L, a, b]` for 8-bit sRGB channels. */
export function srgbToOklab(
  red: number,
  green: number,
  blue: number,
): readonly [number, number, number] {
  const r = srgbChannelToLinear(red / 255);
  const g = srgbChannelToLinear(green / 255);
  const b = srgbChannelToLinear(blue / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Linear sRGB channels (0–1 when in gamut) for an OKLCH colour. */
function oklchToLinearSrgb({ l, c, h }: Oklch): readonly [number, number, number] {
  const radians = (h * Math.PI) / 180;
  const a = c * Math.cos(radians);
  const b = c * Math.sin(radians);
  const lPrime = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mPrime = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const sPrime = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * lPrime - 3.3077115913 * mPrime + 0.2309699292 * sPrime,
    -1.2684380046 * lPrime + 2.6097574011 * mPrime - 0.3413193965 * sPrime,
    -0.0041960863 * lPrime - 0.7034186147 * mPrime + 1.707614701 * sPrime,
  ];
}

function inSrgbGamut(channels: readonly number[]): boolean {
  return channels.every((channel) => channel >= -1e-4 && channel <= 1 + 1e-4);
}

export function hexToOklch(hex: string): Oklch | null {
  const match = HEX_COLOR_PATTERN.exec(hex.trim());
  if (!match?.[1]) return null;
  const value = Number.parseInt(match[1], 16);
  const [l, a, b] = srgbToOklab((value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff);
  return { l, c: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
}

/**
 * The `#rrggbb` colour for an OKLCH colour. A colour too vivid for sRGB keeps
 * its lightness and hue and loses only as much chroma as needed to fit.
 */
export function oklchToHex(color: Oklch): string {
  const l = Math.min(1, Math.max(0, color.l));
  let c = Math.max(0, color.c);
  if (!inSrgbGamut(oklchToLinearSrgb({ l, c, h: color.h }))) {
    let low = 0;
    let high = c;
    for (let iteration = 0; iteration < 24; iteration += 1) {
      const middle = (low + high) / 2;
      if (inSrgbGamut(oklchToLinearSrgb({ l, c: middle, h: color.h }))) low = middle;
      else high = middle;
    }
    c = low;
  }
  return `#${oklchToLinearSrgb({ l, c, h: color.h })
    .map((channel) =>
      Math.round(Math.min(1, Math.max(0, linearChannelToSrgb(channel))) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}
