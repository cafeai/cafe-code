import { describe, expect, it, vi } from "vitest";

import {
  applyAppAccentColor,
  applySidebarAccentColor,
  applySidebarStarSpeed,
  normalizeAccentColor,
  normalizeSidebarStarSpeed,
  sidebarStarDriftDurationSeconds,
  themedAccentColor,
} from "./themeAccent";
import { hexToOklch } from "./lib/oklab";

describe("themeAccent", () => {
  it("draws a chosen accent brighter in light mode and deeper in dark mode", () => {
    const chosen = hexToOklch("#0eacb7")!;
    const light = hexToOklch(themedAccentColor("#0eacb7", "light"))!;
    const dark = hexToOklch(themedAccentColor("#0eacb7", "dark"))!;
    expect(light.l).toBeGreaterThan(chosen.l);
    expect(dark.l).toBeLessThan(chosen.l);
    expect(Math.abs(dark.h - chosen.h)).toBeLessThan(3);
  });

  it("draws an accent more colourfully where sRGB has room", () => {
    // Violet has headroom; a teal already at the sRGB edge can only shift lightness.
    const chosen = hexToOklch("#9d84ec")!;
    const dark = hexToOklch(themedAccentColor("#9d84ec", "dark"))!;
    expect(dark.c).toBeGreaterThan(chosen.c * 1.1);
    expect(Math.abs(dark.h - chosen.h)).toBeLessThan(3);
  });

  it("uses grey accents exactly as chosen", () => {
    expect(themedAccentColor("#808080", "light")).toBe("#808080");
    expect(themedAccentColor("#808080", "dark")).toBe("#808080");
  });

  it("normalizes six-digit hex colors", () => {
    expect(normalizeAccentColor("  #16a34a  ")).toBe("#16a34a");
    expect(normalizeAccentColor("#abc")).toBeUndefined();
    expect(normalizeAccentColor("rebeccapurple")).toBeUndefined();
  });

  it("applies and clears sidebar accent variables", () => {
    const properties = new Map<string, string>();
    const element = {
      style: {
        setProperty: (name: string, value: string) => properties.set(name, value),
        removeProperty: (name: string) => {
          const previous = properties.get(name) ?? "";
          properties.delete(name);
          return previous;
        },
        getPropertyValue: (name: string) => properties.get(name) ?? "",
      },
    };
    vi.stubGlobal("document", { documentElement: element });

    applySidebarAccentColor("#16a34a");

    expect(element.style.getPropertyValue("--cafe-sidebar-accent")).toBe("#16a34a");
    expect(element.style.getPropertyValue("--primary")).toBe("");
    expect(element.style.getPropertyValue("--ring")).toBe("");

    applySidebarAccentColor("");

    expect(element.style.getPropertyValue("--cafe-sidebar-accent")).toBe("");

    vi.unstubAllGlobals();
  });

  it("applies and clears app accent variables", () => {
    const properties = new Map<string, string>();
    const element = {
      style: {
        setProperty: (name: string, value: string) => properties.set(name, value),
        removeProperty: (name: string) => {
          const previous = properties.get(name) ?? "";
          properties.delete(name);
          return previous;
        },
        getPropertyValue: (name: string) => properties.get(name) ?? "",
      },
    };
    vi.stubGlobal("document", { documentElement: element });

    applyAppAccentColor("#dc2626", "dark");

    const drawn = themedAccentColor("#dc2626", "dark");
    expect(element.style.getPropertyValue("--primary")).toBe(drawn);
    expect(element.style.getPropertyValue("--ring")).toBe(drawn);
    expect(element.style.getPropertyValue("--cafe-sidebar-accent")).toBe("");

    applyAppAccentColor("", "dark");

    expect(element.style.getPropertyValue("--primary")).toBe("");
    expect(element.style.getPropertyValue("--ring")).toBe("");

    vi.unstubAllGlobals();
  });

  it("normalizes and converts sidebar star speed into drift duration", () => {
    expect(normalizeSidebarStarSpeed(1)).toBe(1);
    expect(normalizeSidebarStarSpeed(0.25)).toBe(0.25);
    expect(normalizeSidebarStarSpeed(4)).toBe(4);
    expect(normalizeSidebarStarSpeed(0.24)).toBeUndefined();
    expect(normalizeSidebarStarSpeed(4.01)).toBeUndefined();
    expect(normalizeSidebarStarSpeed(Number.NaN)).toBeUndefined();

    expect(sidebarStarDriftDurationSeconds(1)).toBe(60);
    expect(sidebarStarDriftDurationSeconds(2)).toBe(30);
    expect(sidebarStarDriftDurationSeconds(0.5)).toBe(120);
    expect(sidebarStarDriftDurationSeconds(0)).toBeUndefined();
  });

  it("applies and clears sidebar star speed variables", () => {
    const properties = new Map<string, string>();
    const element = {
      style: {
        setProperty: (name: string, value: string) => properties.set(name, value),
        removeProperty: (name: string) => {
          const previous = properties.get(name) ?? "";
          properties.delete(name);
          return previous;
        },
        getPropertyValue: (name: string) => properties.get(name) ?? "",
      },
    };
    vi.stubGlobal("document", { documentElement: element });

    applySidebarStarSpeed(2);

    expect(element.style.getPropertyValue("--cafe-sidebar-star-drift-duration")).toBe("30s");

    applySidebarStarSpeed(1);

    expect(element.style.getPropertyValue("--cafe-sidebar-star-drift-duration")).toBe("");

    applySidebarStarSpeed(0);

    expect(element.style.getPropertyValue("--cafe-sidebar-star-drift-duration")).toBe("");

    vi.unstubAllGlobals();
  });
});
