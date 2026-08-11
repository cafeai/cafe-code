import {
  normalizeSettings,
  presentationProfile,
  type HexagonsPresentationSettings,
} from "./vendor/the-hexagons-runtime-club-code/runtime/config.js";

export const HEXAGONS_BACKGROUND_DOCUMENT_KIND = "the-hexagons-background";
export const HEXAGONS_BACKGROUND_FORMAT_VERSION = 1;
export const MAX_HEXAGONS_BACKGROUND_FILE_BYTES = 256 * 1024;
export const MAX_HEXAGONS_BACKGROUND_NAME_LENGTH = 80;

const HEXAGONS_BACKGROUND_TARGETS = ["generic", "club-code", "jobsearch"] as const;
const FORBIDDEN_SETTINGS_KEYS = ["__proto__", "prototype", "constructor"] as const;
const HOST_ONLY_SETTINGS_KEYS = new Set([
  "enabled",
  "fallingEffectsEnabled",
  "renderer",
  "reducedMotion",
  "continueBackgroundAnimations",
]);
const CURRENT_HEXAGONS_SETTINGS_SCHEMA_VERSION = Number(normalizeSettings({}).schemaVersion);

export type HexagonsBackgroundTarget = (typeof HEXAGONS_BACKGROUND_TARGETS)[number];

export interface HexagonsBackgroundDocument {
  readonly kind: typeof HEXAGONS_BACKGROUND_DOCUMENT_KIND;
  readonly formatVersion: typeof HEXAGONS_BACKGROUND_FORMAT_VERSION;
  readonly name: string;
  readonly target: HexagonsBackgroundTarget;
  readonly createdAt?: string;
  readonly settings: HexagonsPresentationSettings;
  readonly activationHints: {
    readonly backgroundEnabled: false;
    readonly fallingEffectsEnabled: false;
  };
  readonly hostPolicyHints: {
    readonly renderer: "auto";
    readonly reducedMotion: "system";
    readonly continueBackgroundAnimations: false;
  };
}

export interface ParsedHexagonsBackground {
  readonly document: HexagonsBackgroundDocument;
  readonly serialized: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanName(value: unknown): string {
  const name = typeof value === "string" ? value.trim().replace(/\s+/gu, " ") : "";
  return name.slice(0, MAX_HEXAGONS_BACKGROUND_NAME_LENGTH) || "Untitled Hexagons Background";
}

function cleanCreatedAt(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    return undefined;
  }
  return value;
}

function parseTarget(value: unknown): HexagonsBackgroundTarget {
  if (
    typeof value === "string" &&
    (HEXAGONS_BACKGROUND_TARGETS as readonly string[]).includes(value)
  ) {
    return value as HexagonsBackgroundTarget;
  }
  throw new TypeError("The background target is not supported.");
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Validate a portable preset and retain only normalized presentation fields.
 * Activation and host-policy hints never cross this boundary.
 */
export function parseHexagonsBackgroundText(contents: string): ParsedHexagonsBackground {
  if (contents.trim().length === 0) {
    throw new TypeError("The background file is empty.");
  }
  if (utf8Length(contents) > MAX_HEXAGONS_BACKGROUND_FILE_BYTES) {
    throw new RangeError("The background file is larger than 256 KiB.");
  }

  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch {
    throw new TypeError("The background file does not contain valid JSON.");
  }

  if (!isRecord(value)) {
    throw new TypeError("The background file must contain a JSON object.");
  }
  if (value.kind !== HEXAGONS_BACKGROUND_DOCUMENT_KIND) {
    throw new TypeError("This file is not a Hexagons background file.");
  }
  if (value.formatVersion !== HEXAGONS_BACKGROUND_FORMAT_VERSION) {
    throw new RangeError(
      `Background format version ${String(value.formatVersion)} is not supported.`,
    );
  }
  if (!isRecord(value.settings)) {
    throw new TypeError("The background settings are missing.");
  }
  const settingsSchemaVersion = value.settings.schemaVersion;
  if (
    settingsSchemaVersion !== undefined &&
    (typeof settingsSchemaVersion !== "number" ||
      !Number.isInteger(settingsSchemaVersion) ||
      Number(settingsSchemaVersion) < 1 ||
      Number(settingsSchemaVersion) > CURRENT_HEXAGONS_SETTINGS_SCHEMA_VERSION)
  ) {
    throw new RangeError(
      `Background settings schema version ${String(settingsSchemaVersion)} is not supported.`,
    );
  }
  for (const key of FORBIDDEN_SETTINGS_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value.settings, key)) {
      throw new TypeError(`The background settings contain a forbidden key: ${key}.`);
    }
  }

  const createdAt = cleanCreatedAt(value.createdAt);
  const normalized = normalizeSettings(value.settings);
  const presentationSettings = {
    schemaVersion: CURRENT_HEXAGONS_SETTINGS_SCHEMA_VERSION,
    ...Object.fromEntries(
      Object.entries(presentationProfile(normalized)).filter(
        ([key]) => !HOST_ONLY_SETTINGS_KEYS.has(key),
      ),
    ),
  } as HexagonsPresentationSettings;
  const document: HexagonsBackgroundDocument = {
    kind: HEXAGONS_BACKGROUND_DOCUMENT_KIND,
    formatVersion: HEXAGONS_BACKGROUND_FORMAT_VERSION,
    name: cleanName(value.name),
    target: parseTarget(value.target),
    ...(createdAt ? { createdAt } : {}),
    settings: presentationSettings,
    activationHints: {
      backgroundEnabled: false,
      fallingEffectsEnabled: false,
    },
    hostPolicyHints: {
      renderer: "auto",
      reducedMotion: "system",
      continueBackgroundAnimations: false,
    },
  };
  return { document, serialized: JSON.stringify(document) };
}

export async function readHexagonsBackgroundFile(
  file: Pick<File, "size" | "text">,
): Promise<ParsedHexagonsBackground> {
  if (file.size <= 0) {
    throw new TypeError("The background file is empty.");
  }
  if (file.size > MAX_HEXAGONS_BACKGROUND_FILE_BYTES) {
    throw new RangeError("The background file is larger than 256 KiB.");
  }
  return parseHexagonsBackgroundText(await file.text());
}

export function parseStoredHexagonsBackground(
  serialized: string | null,
): ParsedHexagonsBackground | null {
  if (serialized === null) return null;
  try {
    return parseHexagonsBackgroundText(serialized);
  } catch {
    return null;
  }
}
