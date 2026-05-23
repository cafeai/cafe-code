import { describe, expect, it, vi } from "vitest";

import { applyThemeAccentColor, normalizeThemeAccentColor } from "./themeAccent";

describe("themeAccent", () => {
  it("normalizes six-digit hex colors", () => {
    expect(normalizeThemeAccentColor("  #16a34a  ")).toBe("#16a34a");
    expect(normalizeThemeAccentColor("#abc")).toBeUndefined();
    expect(normalizeThemeAccentColor("rebeccapurple")).toBeUndefined();
  });

  it("applies and clears root accent variables", () => {
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

    applyThemeAccentColor("#16a34a");

    expect(element.style.getPropertyValue("--cafe-sidebar-accent")).toBe("#16a34a");
    expect(element.style.getPropertyValue("--primary")).toBe("");
    expect(element.style.getPropertyValue("--ring")).toBe("");

    applyThemeAccentColor("");

    expect(element.style.getPropertyValue("--cafe-sidebar-accent")).toBe("");

    vi.unstubAllGlobals();
  });
});
