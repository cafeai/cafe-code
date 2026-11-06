import { useEffect, useState } from "react";

import type { ResolvedSidebarImage } from "./hooks/useSidebarImage";
import { srgbToOklab } from "./lib/oklab";
import { sidebarImageSwatch } from "./sidebarImages";

/**
 * The colour of the soft glow behind the sidebar picture (`--cafe-sidebar-glow`
 * in index.css). Built-in scenes glow in the colour their art was made around;
 * a custom picture glows slightly toward its own colour. Grey pictures, and
 * pictures whose pixels the renderer may not read, keep the accent colour.
 */

const GLOW_VARIABLE = "--cafe-sidebar-glow";
/** Pictures are sampled at this size: enough for an average, cheap to read. */
const SAMPLE_SIZE = 24;
/** Below this averaged OKLab chroma a picture reads as grey. */
const NEUTRAL_CHROMA = 0.012;
const GLOW_LIGHTNESS = 0.62;
/**
 * A picture's average colour is much duller than its most colourful parts, so
 * it is boosted, then kept within the chroma range of the built-in scene colours
 * so a custom glow is as gentle as a built-in one.
 */
const GLOW_CHROMA_GAIN = 4;
const MIN_GLOW_CHROMA = 0.07;
const MAX_GLOW_CHROMA = 0.15;
const MAX_CACHED_PICTURES = 8;

/**
 * The glow colour for RGBA pixels, or null when the picture reads as grey.
 * Colourful pixels count for more, so a coloured subject is not drowned out by
 * a large grey background. Mostly transparent pixels are ignored.
 */
export function glowColorFromPixels(rgba: ArrayLike<number>): string | null {
  let sumA = 0;
  let sumB = 0;
  let totalWeight = 0;
  for (let index = 0; index + 3 < rgba.length; index += 4) {
    if ((rgba[index + 3] ?? 0) < 128) continue;
    const [, a, b] = srgbToOklab(rgba[index] ?? 0, rgba[index + 1] ?? 0, rgba[index + 2] ?? 0);
    const weight = 0.02 + Math.hypot(a, b);
    sumA += a * weight;
    sumB += b * weight;
    totalWeight += weight;
  }
  if (totalWeight === 0) return null;
  const a = sumA / totalWeight;
  const b = sumB / totalWeight;
  const chroma = Math.hypot(a, b);
  if (chroma < NEUTRAL_CHROMA) return null;
  const hue = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  const glowChroma = Math.min(
    MAX_GLOW_CHROMA,
    Math.max(MIN_GLOW_CHROMA, chroma * GLOW_CHROMA_GAIN),
  );
  return `oklch(${GLOW_LIGHTNESS} ${glowChroma.toFixed(3)} ${hue.toFixed(1)})`;
}

// Keyed by image URL. A new upload gets a new URL, so entries never go stale.
const glowByPicture = new Map<string, string | null>();

function rememberGlow(src: string, color: string | null) {
  glowByPicture.delete(src);
  glowByPicture.set(src, color);
  while (glowByPicture.size > MAX_CACHED_PICTURES) {
    const oldest = glowByPicture.keys().next().value;
    if (oldest === undefined) break;
    glowByPicture.delete(oldest);
  }
}

function readPictureGlow(src: string): Promise<string | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.decoding = "async";
    image.addEventListener("load", () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = SAMPLE_SIZE;
        canvas.height = SAMPLE_SIZE;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) return resolve(null);
        context.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
        resolve(glowColorFromPixels(context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data));
      } catch {
        // A cross-origin picture cannot be read back; the accent glow stays.
        resolve(null);
      }
    });
    image.addEventListener("error", () => resolve(null));
    image.src = src;
  });
}

/** The glow colour for the sidebar picture, or null for the accent colour. */
export function useSidebarGlowColor(image: ResolvedSidebarImage): string | null {
  const customSrc = image.mode !== "off" && image.showsCustomImage ? image.src : null;
  const [read, setRead] = useState<{ readonly src: string; readonly color: string | null }>();

  useEffect(() => {
    if (customSrc === null || glowByPicture.has(customSrc)) return;
    let current = true;
    void readPictureGlow(customSrc).then((color) => {
      rememberGlow(customSrc, color);
      if (current) setRead({ src: customSrc, color });
    });
    return () => {
      current = false;
    };
  }, [customSrc]);

  if (image.mode === "off") return null;
  if (customSrc === null) return sidebarImageSwatch(image.colorId);
  if (glowByPicture.has(customSrc)) return glowByPicture.get(customSrc) ?? null;
  return read?.src === customSrc ? read.color : null;
}

/** Applies the sidebar picture's glow colour for as long as the sidebar is mounted. */
export function useSidebarGlow(image: ResolvedSidebarImage): void {
  const color = useSidebarGlowColor(image);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    if (color === null) root.style.removeProperty(GLOW_VARIABLE);
    else root.style.setProperty(GLOW_VARIABLE, color);
    return () => {
      root.style.removeProperty(GLOW_VARIABLE);
    };
  }, [color]);
}
