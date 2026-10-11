import { uiText } from "@cafecode/shared/i18n";
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
    get label() {
      return uiText("Stars");
    },
    backend: "2d",
    cost: "light",
    previewClass: "cafe-ambiance-preview-stars",
  },
  {
    effect: "rain",
    get label() {
      return uiText("Rain");
    },
    backend: "2d",
    cost: "light",
    previewClass: "cafe-ambiance-preview-rain",
  },
  {
    effect: "snow",
    get label() {
      return uiText("Snow");
    },
    backend: "2d",
    cost: "light",
    previewClass: "cafe-ambiance-preview-snow",
  },
  {
    effect: "matrix",
    get label() {
      return uiText("Matrix");
    },
    backend: "2d",
    cost: "light",
    previewClass: "cafe-ambiance-preview-matrix",
  },
  {
    effect: "fire",
    get label() {
      return uiText("Fire");
    },
    backend: "2d",
    cost: "light",
    previewClass: "cafe-ambiance-preview-fire",
  },
  {
    effect: "glass",
    get label() {
      return uiText("Glass");
    },
    backend: "2d",
    cost: "light",
    previewClass: "cafe-ambiance-preview-glass",
  },
  {
    effect: "lattice",
    get label() {
      return uiText("Lattice");
    },
    backend: "2d",
    cost: "light",
    previewClass: "cafe-ambiance-preview-lattice",
  },
  {
    effect: "blossom",
    get label() {
      return uiText("Blossom");
    },
    backend: "2d",
    cost: "light",
    previewClass: "cafe-ambiance-preview-blossom",
  },
  // ── WebGL fullscreen quad ────────────────────────────────────────
  {
    effect: "aurora",
    get label() {
      return uiText("Aurora");
    },
    backend: "webgl",
    cost: "light",
    previewClass: "cafe-ambiance-preview-aurora",
  },
  {
    effect: "grid",
    get label() {
      return uiText("Grid");
    },
    backend: "webgl",
    cost: "light",
    previewClass: "cafe-ambiance-preview-grid",
  },
  {
    effect: "horizon",
    get label() {
      return uiText("Horizon");
    },
    backend: "webgl",
    cost: "light",
    previewClass: "cafe-ambiance-preview-horizon",
  },
  {
    effect: "resonance",
    get label() {
      return uiText("Resonance");
    },
    backend: "webgl",
    cost: "medium",
    previewClass: "cafe-ambiance-preview-resonance",
  },
  {
    effect: "converge",
    get label() {
      return uiText("Converge");
    },
    backend: "webgl",
    cost: "medium",
    previewClass: "cafe-ambiance-preview-converge",
  },
  {
    effect: "beam",
    get label() {
      return uiText("Beam");
    },
    backend: "webgl",
    cost: "medium",
    previewClass: "cafe-ambiance-preview-beam",
  },
  {
    effect: "terminal",
    get label() {
      return uiText("Terminal");
    },
    backend: "webgl",
    cost: "medium",
    previewClass: "cafe-ambiance-preview-terminal",
  },
  {
    effect: "core",
    get label() {
      return uiText("Core");
    },
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
  get light() {
    return uiText("Light", undefined, "ambiance-cost");
  },
  get medium() {
    return uiText("Medium");
  },
  get heavy() {
    return uiText("Heavy");
  },
};
