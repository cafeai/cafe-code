export interface HexagonsPresentationSettings {
  readonly [key: string]: boolean | number | string;
}

export interface HexagonsRuntimeSettings extends HexagonsPresentationSettings {
  readonly schemaVersion: 10;
  readonly enabled: boolean;
  readonly fallingEffectsEnabled: boolean;
  readonly renderer: "auto" | "gpu" | "canvas";
  readonly reducedMotion: "system" | "always" | "never";
  readonly continueBackgroundAnimations: boolean;
  readonly tessellationMode: "rhombille" | "cairo-pentagon" | "hexagram";
  readonly colorPattern:
    | "facet"
    | "backyard-star"
    | "rotating-triplets"
    | "checker"
    | "rings"
    | "seeded-mosaic";
  readonly patternScale: number;
  readonly patternPhase: number;
  readonly patternRotation: number;
  readonly patternMirror: boolean;
}

export const SCHEMA_VERSION: 10;
export const PROFILE_PRESENTATION_KEYS: readonly string[];

export function normalizeSettings(
  input?: Readonly<Record<string, unknown>>,
): HexagonsRuntimeSettings;

export function presentationProfile(
  settings: Readonly<Record<string, unknown>>,
): HexagonsPresentationSettings;
