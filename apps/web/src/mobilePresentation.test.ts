import { describe, expect, it } from "vitest";

import { resolveMobileLayout } from "./mobilePresentation";

describe("mobile presentation", () => {
  it("keeps responsive desktop presentation as the default on wide screens", () => {
    expect(resolveMobileLayout(false, false)).toBe(false);
  });

  it("forces mobile presentation on wide screens when the operator enables it", () => {
    expect(resolveMobileLayout(false, true)).toBe(true);
  });

  it("keeps the mobile layout on narrow screens regardless of the override", () => {
    expect(resolveMobileLayout(true, false)).toBe(true);
    expect(resolveMobileLayout(true, true)).toBe(true);
  });
});
