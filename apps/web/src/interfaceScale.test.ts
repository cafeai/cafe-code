import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyInterfaceScalePercent,
  normalizeInterfaceScalePercent,
  snapInterfaceScalePercent,
} from "./interfaceScale";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("interfaceScale", () => {
  it("accepts only bounded integer percentages", () => {
    expect(normalizeInterfaceScalePercent(80)).toBe(80);
    expect(normalizeInterfaceScalePercent(100)).toBe(100);
    expect(normalizeInterfaceScalePercent(130)).toBe(130);
    expect(normalizeInterfaceScalePercent(79)).toBeUndefined();
    expect(normalizeInterfaceScalePercent(131)).toBeUndefined();
    expect(normalizeInterfaceScalePercent(100.5)).toBeUndefined();
    expect(normalizeInterfaceScalePercent(Number.NaN)).toBeUndefined();
  });

  it("snaps UI input to supported five-percent steps", () => {
    expect(snapInterfaceScalePercent(72)).toBe(80);
    expect(snapInterfaceScalePercent(103)).toBe(105);
    expect(snapInterfaceScalePercent(140)).toBe(130);
  });

  it("applies non-default scale and clears default or invalid values", () => {
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

    applyInterfaceScalePercent(125);
    expect(element.style.getPropertyValue("font-size")).toBe("125%");

    applyInterfaceScalePercent(100);
    expect(element.style.getPropertyValue("font-size")).toBe("");

    applyInterfaceScalePercent(500);
    expect(element.style.getPropertyValue("font-size")).toBe("");
  });
});
