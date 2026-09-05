import type { AmbianceEffect } from "@cafecode/contracts";

/**
 * Effect catalog shared by the renderer and the Settings → Ambiance picker.
 *
 * Two independent axes live here:
 *
 * - `backend` decides which canvas context the layer mounts. A canvas can only
 *   ever hold one context type, so `AmbianceLayer` remounts its canvas element
 *   when the selected effect switches between "2d" and "webgl".
 * - `cost` is what the picker shows the user. It is deliberately separate from
 *   the backend: a WebGL effect can be cheaper than a 2D one, and the range
 *   across this catalog is wide enough (a 50-node 2D graph up to a per-pixel
 *   volumetric orb) that picking blind on a weak machine is a real hazard.
 */
export type AmbianceBackend = "2d" | "webgl";
export type AmbianceCost = "light" | "medium" | "heavy";

export type AmbianceEffectMeta = {
  effect: AmbianceEffect;
  label: string;
  backend: AmbianceBackend;
  cost: AmbianceCost;
  /** Class applied to the settings tile for its looping CSS preview. */
  previewClass: string;
};

export const AMBIANCE_EFFECTS: ReadonlyArray<AmbianceEffectMeta> = [
  // ── canvas 2D ────────────────────────────────────────────────────
  {
    effect: "stars",
    label: "Stars",
    backend: "2d",
    cost: "light",
    previewClass: "cafe-ambiance-preview-stars",
  },
  {
    effect: "rain",
    label: "Rain",
    backend: "2d",
    cost: "light",
    previewClass: "cafe-ambiance-preview-rain",
  },
  {
    effect: "snow",
    label: "Snow",
    backend: "2d",
    cost: "light",
    previewClass: "cafe-ambiance-preview-snow",
  },
  {
    effect: "matrix",
    label: "Matrix",
    backend: "2d",
    cost: "light",
    previewClass: "cafe-ambiance-preview-matrix",
  },
  {
    effect: "fire",
    label: "Fire",
    backend: "2d",
    cost: "light",
    previewClass: "cafe-ambiance-preview-fire",
  },
  {
    effect: "glass",
    label: "Glass",
    backend: "2d",
    cost: "light",
    previewClass: "cafe-ambiance-preview-glass",
  },
  {
    effect: "lattice",
    label: "Lattice",
    backend: "2d",
    cost: "light",
    previewClass: "cafe-ambiance-preview-lattice",
  },
  {
    effect: "blossom",
    label: "Blossom",
    backend: "2d",
    cost: "light",
    previewClass: "cafe-ambiance-preview-blossom",
  },
  // ── WebGL fullscreen quad ────────────────────────────────────────
  {
    effect: "aurora",
    label: "Aurora",
    backend: "webgl",
    cost: "light",
    previewClass: "cafe-ambiance-preview-aurora",
  },
  {
    effect: "grid",
    label: "Grid",
    backend: "webgl",
    cost: "light",
    previewClass: "cafe-ambiance-preview-grid",
  },
  {
    effect: "horizon",
    label: "Horizon",
    backend: "webgl",
    cost: "light",
    previewClass: "cafe-ambiance-preview-horizon",
  },
  {
    effect: "resonance",
    label: "Resonance",
    backend: "webgl",
    cost: "medium",
    previewClass: "cafe-ambiance-preview-resonance",
  },
  {
    effect: "converge",
    label: "Converge",
    backend: "webgl",
    cost: "medium",
    previewClass: "cafe-ambiance-preview-converge",
  },
  {
    effect: "beam",
    label: "Beam",
    backend: "webgl",
    cost: "medium",
    previewClass: "cafe-ambiance-preview-beam",
  },
  {
    effect: "terminal",
    label: "Terminal",
    backend: "webgl",
    cost: "medium",
    previewClass: "cafe-ambiance-preview-terminal",
  },
  {
    effect: "core",
    label: "Core",
    backend: "webgl",
    cost: "heavy",
    previewClass: "cafe-ambiance-preview-core",
  },
];

const META_BY_EFFECT = new Map<AmbianceEffect, AmbianceEffectMeta>(
  AMBIANCE_EFFECTS.map((meta) => [meta.effect, meta]),
);

const FALLBACK_META: AmbianceEffectMeta = AMBIANCE_EFFECTS[1]!; // rain

export function ambianceEffectMeta(effect: AmbianceEffect): AmbianceEffectMeta {
  return META_BY_EFFECT.get(effect) ?? FALLBACK_META;
}

export function ambianceBackend(effect: AmbianceEffect): AmbianceBackend {
  return ambianceEffectMeta(effect).backend;
}

export const AMBIANCE_COST_LABEL: Record<AmbianceCost, string> = {
  light: "Light",
  medium: "Medium",
  heavy: "Heavy",
};
