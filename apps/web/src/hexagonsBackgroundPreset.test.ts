import { describe, expect, it } from "vitest";

import {
  HEXAGONS_BACKGROUND_DOCUMENT_KIND,
  HEXAGONS_BACKGROUND_FORMAT_VERSION,
  MAX_HEXAGONS_BACKGROUND_FILE_BYTES,
  parseHexagonsBackgroundText,
  parseStoredHexagonsBackground,
} from "./hexagonsBackgroundPreset";

function preset(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: HEXAGONS_BACKGROUND_DOCUMENT_KIND,
    formatVersion: HEXAGONS_BACKGROUND_FORMAT_VERSION,
    name: "  Black   Light  ",
    target: "club-code",
    settings: {
      quality: "cinematic",
      material: "glass",
      frontLightEnabled: true,
      frontLightColor: "#9900ff",
      emberPulse: true,
      enabled: true,
      fallingEffectsEnabled: true,
      renderer: "gpu",
      reducedMotion: "never",
      continueBackgroundAnimations: true,
    },
    activationHints: {
      backgroundEnabled: true,
      fallingEffectsEnabled: true,
    },
    hostPolicyHints: {
      renderer: "gpu",
      reducedMotion: "never",
      continueBackgroundAnimations: true,
    },
    ...overrides,
  });
}

describe("The Hexagons background preset boundary", () => {
  it("retains normalized presentation and replaces activation and host-policy hints", () => {
    const parsed = parseHexagonsBackgroundText(preset());

    expect(parsed.document.name).toBe("Black Light");
    expect(parsed.document.target).toBe("club-code");
    expect(parsed.document.settings).toMatchObject({
      schemaVersion: 10,
      quality: "cinematic",
      material: "glass",
      frontLightEnabled: true,
      frontLightColor: "#9900ff",
      emberPulse: true,
    });
    expect(parsed.document.settings).not.toHaveProperty("enabled");
    expect(parsed.document.settings).not.toHaveProperty("fallingEffectsEnabled");
    expect(parsed.document.settings).not.toHaveProperty("renderer");
    expect(parsed.document.settings).not.toHaveProperty("reducedMotion");
    expect(parsed.document.settings).not.toHaveProperty("continueBackgroundAnimations");
    expect(parsed.document.activationHints).toEqual({
      backgroundEnabled: false,
      fallingEffectsEnabled: false,
    });
    expect(parsed.document.hostPolicyHints).toEqual({
      renderer: "auto",
      reducedMotion: "system",
      continueBackgroundAnimations: false,
    });
    expect(JSON.parse(parsed.serialized)).toEqual(parsed.document);
  });

  it("migrates versionless settings and rejects future settings schemas", () => {
    expect(parseHexagonsBackgroundText(preset()).document.settings.schemaVersion).toBe(10);
    expect(
      parseHexagonsBackgroundText(preset({ settings: { schemaVersion: 1, material: "glass" } }))
        .document.settings.schemaVersion,
    ).toBe(10);
    expect(() =>
      parseHexagonsBackgroundText(preset({ settings: { schemaVersion: 11, material: "glass" } })),
    ).toThrow("settings schema version 11 is not supported");
  });

  it("imports schema-10 tessellation and pattern settings without flattening them", () => {
    const parsed = parseHexagonsBackgroundText(
      preset({
        settings: {
          schemaVersion: 10,
          tessellationMode: "hexagram",
          colorPattern: "rings",
          patternScale: 3,
          patternPhase: 2,
          patternRotation: 1,
          patternMirror: true,
          particleCount: 12_000,
        },
      }),
    );

    expect(parsed.document.settings).toMatchObject({
      schemaVersion: 10,
      tessellationMode: "hexagram",
      colorPattern: "rings",
      patternScale: 3,
      patternPhase: 2,
      patternRotation: 1,
      patternMirror: true,
      particleCount: 12_000,
    });
  });

  it("migrates the pre-schema-9 backyard pattern to its corrected layout", () => {
    const parsed = parseHexagonsBackgroundText(
      preset({ settings: { schemaVersion: 8, colorPattern: "backyard-star" } }),
    );

    expect(parsed.document.settings).toMatchObject({
      schemaVersion: 10,
      colorPattern: "rotating-triplets",
    });
  });

  it("fails closed for invalid, unsupported, and oversized documents", () => {
    expect(() => parseHexagonsBackgroundText(" ")).toThrow("empty");
    expect(() => parseHexagonsBackgroundText("not json")).toThrow("valid JSON");
    expect(() => parseHexagonsBackgroundText(preset({ kind: "background" }))).toThrow(
      "not a Hexagons background file",
    );
    expect(() => parseHexagonsBackgroundText(preset({ formatVersion: 2 }))).toThrow(
      "not supported",
    );
    expect(() => parseHexagonsBackgroundText(preset({ target: "unknown" }))).toThrow(
      "target is not supported",
    );
    expect(() =>
      parseHexagonsBackgroundText("x".repeat(MAX_HEXAGONS_BACKGROUND_FILE_BYTES + 1)),
    ).toThrow("larger than 256 KiB");
  });

  it("rejects forbidden settings keys before normalization", () => {
    const source = preset();
    const value = JSON.parse(source) as Record<string, unknown>;
    const settings = value.settings as Record<string, unknown>;
    Object.defineProperty(settings, "constructor", { value: {}, enumerable: true });

    expect(() => parseHexagonsBackgroundText(JSON.stringify(value))).toThrow(
      "forbidden key: constructor",
    );
  });

  it("returns null for invalid stored state instead of starting the renderer", () => {
    expect(parseStoredHexagonsBackground(null)).toBeNull();
    expect(parseStoredHexagonsBackground("broken")).toBeNull();
    expect(parseStoredHexagonsBackground(preset())?.document.name).toBe("Black Light");
  });
});
