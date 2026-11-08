import { describe, expect, it } from "vitest";

import { chatRightPanelWidthBounds, resolveChatRightPanelWidth } from "./rightPanelLayout";

describe("inline chat right-panel sizing", () => {
  it("keeps the chat usable while allowing a wider Tasks column", () => {
    expect(chatRightPanelWidthBounds(900)).toEqual({ min: 220, max: 580 });
    expect(resolveChatRightPanelWidth(480, 900)).toBe(480);
    expect(resolveChatRightPanelWidth(640, 900)).toBe(580);
    expect(chatRightPanelWidthBounds(1600)).toEqual({ min: 220, max: 640 });
  });

  it("fits a saved preference to a narrow split without overwriting it", () => {
    const preference = 480;
    expect(resolveChatRightPanelWidth(preference, 540)).toBe(220);
    expect(resolveChatRightPanelWidth(preference, 1000)).toBe(480);
    expect(resolveChatRightPanelWidth(null, 1000, 300)).toBe(300);
  });

  it("remains finite and contained when native layout is absent or too narrow", () => {
    for (const width of [0, -1, Number.NaN, Infinity]) {
      expect(chatRightPanelWidthBounds(width)).toEqual({ min: 0, max: 0 });
      expect(resolveChatRightPanelWidth(480, width)).toBe(0);
    }
    expect(resolveChatRightPanelWidth(480, 500)).toBe(180);
  });
});
