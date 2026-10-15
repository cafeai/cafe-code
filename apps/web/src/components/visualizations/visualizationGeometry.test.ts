import { afterEach, describe, expect, it, vi } from "vitest";
import { visualizationGeometry } from "./visualizationGeometry";

/** Numeric admission fixtures only. Actual transformed frame visibility and
 * trusted input remain qualified by the ordinary browser cases separately. */
function anchor(left: number, top: number, width: number, height: number) {
  const document = {};
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { innerWidth: 300, innerHeight: 500 });
  vi.stubGlobal("getComputedStyle", () => ({
    visibility: "visible",
    display: "block",
    contain: "none",
    overflowX: "visible",
    overflowY: "visible",
  }));
  return {
    isConnected: true,
    ownerDocument: document,
    parentElement: null,
    inert: false,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ left, top, right: left + width, bottom: top + height }),
  } as unknown as HTMLElement;
}

afterEach(() => vi.unstubAllGlobals());
describe("ordinary inline frame geometry", () => {
  it("intersects the actual far edge of a frame wider than the former surface limit", () => {
    expect(visualizationGeometry(anchor(-1700, 0, 2400, 360))).toEqual({
      bounds: { x: -1700, y: 0, width: 2400, height: 360 },
      clipBounds: { x: 0, y: 0, width: 300, height: 360 },
    });
  });
  it("intersects the actual lower edge of a transformed tall frame", () => {
    expect(visualizationGeometry(anchor(0, -2200, 300, 2880))).toEqual({
      bounds: { x: 0, y: -2200, width: 300, height: 2880 },
      clipBounds: { x: 0, y: 0, width: 300, height: 500 },
    });
  });
  it.each([
    [0, 0, 32769, 360],
    [0, 0, 300, 32769],
    [32769, 0, 300, 360],
    [0, -32769, 300, 360],
    [0, 0, Number.POSITIVE_INFINITY, 360],
    [0, 0, 300, Number.NaN],
    [0, 0, 0, 360],
  ])("refuses unreasonable or absent numeric geometry (%s,%s,%s,%s)", (...values) => {
    expect(
      visualizationGeometry(anchor(...(values as [number, number, number, number]))),
    ).toBeNull();
  });
});
