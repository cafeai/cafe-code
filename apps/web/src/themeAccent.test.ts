import { describe, expect, it, vi } from "vitest";

import {
  applyAppAccentColor,
  applySidebarAccentColor,
  applySidebarStarSpeed,
  normalizeAccentColor,
  normalizeSidebarStarSpeed,
  sidebarStarDriftDurationSeconds,
} from "./themeAccent";

describe("themeAccent", () => {
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

    applyAppAccentColor("#dc2626");

    expect(element.style.getPropertyValue("--primary")).toBe("#dc2626");
    expect(element.style.getPropertyValue("--ring")).toBe("#dc2626");
    expect(element.style.getPropertyValue("--cafe-sidebar-accent")).toBe("");

    applyAppAccentColor("");

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
