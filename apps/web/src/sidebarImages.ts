/**
 * Built-in sidebar images: the mascot in eight scenes, each with a dark and a
 * light version. "Match color" picks the scene whose colour is closest to the
 * effective accent color (Settings → Appearance → Accent color), which also
 * colors the sidebar and the app icon.
 *
 * The eight colours are 45° apart in OKLCH hue (a perceptual colour space),
 * anchored on the mascot's teal hair, so neighbouring scenes look evenly
 * different instead of crowding several greens together as raw HSL spacing
 * would. Each scene's art was generated around its `swatch` colour.
 */

import type { SidebarImageSource } from "@cafecode/contracts/settings";

import { hexToOklch } from "./lib/oklab";

export const SIDEBAR_IMAGE_COLOR_IDS = [
  "teal",
  "blue",
  "violet",
  "pink",
  "red",
  "amber",
  "lime",
  "green",
] as const;

export type SidebarImageColorId = (typeof SIDEBAR_IMAGE_COLOR_IDS)[number];
export type SidebarImageTheme = "dark" | "light";

export interface SidebarImageColor {
  readonly id: SidebarImageColorId;
  /** OKLCH hue in degrees used for nearest-colour matching. */
  readonly hue: number;
  /** The scene's accent colour; also offered as a one-click sidebar colour. */
  readonly swatch: string;
}

export const SIDEBAR_IMAGE_COLORS: readonly SidebarImageColor[] = [
  { id: "teal", hue: 203, swatch: "#0eacb7" },
  { id: "blue", hue: 248, swatch: "#3d9eef" },
  { id: "violet", hue: 293, swatch: "#9d84ec" },
  { id: "pink", hue: 338, swatch: "#d270b8" },
  { id: "red", hue: 23, swatch: "#e66e6c" },
  { id: "amber", hue: 68, swatch: "#d28411" },
  { id: "lime", hue: 113, swatch: "#9aa107" },
  { id: "green", hue: 158, swatch: "#24b373" },
];

/**
 * The theme's default `--primary` (apps/web/src/index.css, oklch 0.488/0.588
 * 0.217 264) used when no accent color is saved, so matching follows what the
 * user sees in buttons and the sidebar.
 */
export const DEFAULT_SIDEBAR_ACCENT_BY_THEME: Readonly<Record<SidebarImageTheme, string>> = {
  light: "#1b4ed8",
  dark: "#366ffb",
};

/** Below this OKLCH chroma a colour reads as grey and has no useful hue. */
const NEUTRAL_CHROMA_THRESHOLD = 0.03;
const FALLBACK_COLOR_ID: SidebarImageColorId = "teal";

/** Returns OKLCH chroma and hue (degrees) for a `#rrggbb` colour. */
export function hexToOklchHue(
  hex: string,
): { readonly chroma: number; readonly hue: number } | null {
  const oklch = hexToOklch(hex);
  return oklch ? { chroma: oklch.c, hue: oklch.h } : null;
}

function hueDistance(left: number, right: number): number {
  const difference = Math.abs(left - right) % 360;
  return Math.min(difference, 360 - difference);
}

/**
 * Picks the built-in scene closest to the sidebar colour. An empty or invalid
 * saved colour uses the theme's default sidebar accent; greys fall back to teal.
 */
export function resolveSidebarImageColor(
  sidebarColor: string | undefined,
  theme: SidebarImageTheme,
): SidebarImageColorId {
  const oklch =
    hexToOklchHue(sidebarColor ?? "") ?? hexToOklchHue(DEFAULT_SIDEBAR_ACCENT_BY_THEME[theme]);
  if (!oklch || oklch.chroma < NEUTRAL_CHROMA_THRESHOLD) return FALLBACK_COLOR_ID;
  let best = SIDEBAR_IMAGE_COLORS[0]!;
  for (const color of SIDEBAR_IMAGE_COLORS) {
    if (hueDistance(color.hue, oklch.hue) < hueDistance(best.hue, oklch.hue)) best = color;
  }
  return best.id;
}

// Eager URL imports: only the srcset entry the browser picks is fetched.
const SIDEBAR_IMAGE_URLS = import.meta.glob<string>("./assets/sidebar-images/*.webp", {
  eager: true,
  query: "?url",
  import: "default",
});

const SIDEBAR_IMAGE_WIDTHS = [128, 256, 384] as const;

function sidebarImageUrl(color: SidebarImageColorId, theme: SidebarImageTheme, width: number) {
  const url = SIDEBAR_IMAGE_URLS[`./assets/sidebar-images/${color}-${theme}-${width}.webp`];
  if (!url) throw new Error(`Missing built-in sidebar image ${color}-${theme}-${width}.`);
  return url;
}

export interface BuiltInSidebarImageSource {
  readonly src: string;
  readonly srcSet: string;
}

/** `src`/`srcSet` for a built-in scene; pair with `sizes="102px"`. */
export function builtInSidebarImageSource(
  color: SidebarImageColorId,
  theme: SidebarImageTheme,
): BuiltInSidebarImageSource {
  return {
    src: sidebarImageUrl(color, theme, 256),
    srcSet: SIDEBAR_IMAGE_WIDTHS.map(
      (width) => `${sidebarImageUrl(color, theme, width)} ${width}w`,
    ).join(", "),
  };
}

/** The scene's accent colour, which its art was generated around. */
export function sidebarImageSwatch(color: SidebarImageColorId): string {
  return (
    SIDEBAR_IMAGE_COLORS.find((entry) => entry.id === color)?.swatch ??
    SIDEBAR_IMAGE_COLORS[0]!.swatch
  );
}

export type SidebarImageMode = "off" | "match" | "custom";

/** Settings → Appearance → Sidebar image, including settings saved before the choice existed. */
export function resolveSidebarImageMode(input: {
  readonly showSidebarMascot: boolean;
  readonly sidebarImageSource: SidebarImageSource;
  readonly hasCustomImage: boolean;
}): SidebarImageMode {
  if (!input.showSidebarMascot) return "off";
  if (input.sidebarImageSource === "auto") return input.hasCustomImage ? "custom" : "match";
  return input.sidebarImageSource;
}
