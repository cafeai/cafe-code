import { describe, expect, it } from "vitest";

import {
  builtInSidebarImageSource,
  hexToOklchHue,
  resolveSidebarImageColor,
  resolveSidebarImageMode,
  SIDEBAR_IMAGE_COLOR_IDS,
  SIDEBAR_IMAGE_COLORS,
} from "./sidebarImages";

describe("resolveSidebarImageColor", () => {
  it("maps each scene's own swatch back to that scene in both themes", () => {
    for (const color of SIDEBAR_IMAGE_COLORS) {
      expect(resolveSidebarImageColor(color.swatch, "dark")).toBe(color.id);
      expect(resolveSidebarImageColor(color.swatch, "light")).toBe(color.id);
    }
  });

  it("follows the theme's default accent color when none is saved", () => {
    // The default --primary is an indigo-blue (oklch hue 264) in both themes.
    expect(resolveSidebarImageColor("", "dark")).toBe("blue");
    expect(resolveSidebarImageColor("", "light")).toBe("blue");
    expect(resolveSidebarImageColor("not-a-color", "light")).toBe("blue");
  });

  it("matches arbitrary colors by nearest hue, wrapping around red", () => {
    expect(resolveSidebarImageColor("#ff0000", "dark")).toBe("red");
    expect(resolveSidebarImageColor("#ff00aa", "dark")).toBe("pink");
    expect(resolveSidebarImageColor("#ffd400", "dark")).toBe("lime");
    expect(resolveSidebarImageColor("#00ff66", "dark")).toBe("green");
  });

  it("falls back to teal for greys", () => {
    expect(resolveSidebarImageColor("#808080", "dark")).toBe("teal");
    expect(resolveSidebarImageColor("#ffffff", "light")).toBe("teal");
    expect(hexToOklchHue("#808080")?.chroma).toBeLessThan(0.03);
  });
});

describe("builtInSidebarImageSource", () => {
  it("provides a three-width srcset for every scene and theme", () => {
    for (const id of SIDEBAR_IMAGE_COLOR_IDS) {
      for (const theme of ["dark", "light"] as const) {
        const source = builtInSidebarImageSource(id, theme);
        expect(source.src).toBeTruthy();
        expect(source.srcSet.split(", ").map((entry) => entry.split(" ").at(-1))).toEqual([
          "128w",
          "256w",
          "384w",
        ]);
      }
    }
  });
});

describe("resolveSidebarImageMode", () => {
  it("keeps legacy custom uploads visible and defaults everyone else to matching", () => {
    expect(
      resolveSidebarImageMode({
        showSidebarMascot: true,
        sidebarImageSource: "auto",
        hasCustomImage: true,
      }),
    ).toBe("custom");
    expect(
      resolveSidebarImageMode({
        showSidebarMascot: true,
        sidebarImageSource: "auto",
        hasCustomImage: false,
      }),
    ).toBe("match");
  });

  it("honours an explicit choice and the off switch", () => {
    expect(
      resolveSidebarImageMode({
        showSidebarMascot: true,
        sidebarImageSource: "match",
        hasCustomImage: true,
      }),
    ).toBe("match");
    expect(
      resolveSidebarImageMode({
        showSidebarMascot: true,
        sidebarImageSource: "custom",
        hasCustomImage: false,
      }),
    ).toBe("custom");
    expect(
      resolveSidebarImageMode({
        showSidebarMascot: false,
        sidebarImageSource: "custom",
        hasCustomImage: true,
      }),
    ).toBe("off");
  });
});
