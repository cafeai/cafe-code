import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";

import {
  ClientSettingsPatch,
  ClientSettingsSchema,
  DEFAULT_APP_ACCENT_COLOR,
  DEFAULT_BRAND_WORDMARK_PREFIX,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_CONTINUE_BACKGROUND_ANIMATIONS,
  DEFAULT_POWER_SAVE_BLOCKER_MODE,
  DEFAULT_SHOW_SIDEBAR_ATTRIBUTION,
  DEFAULT_SIDEBAR_BRAND_IMAGE_DATA_URL,
  DEFAULT_SIDEBAR_STAR_SPEED,
  DEFAULT_SHOW_SIDEBAR_MASCOT,
  DEFAULT_THEME_ACCENT_COLOR,
  MAX_BRAND_WORDMARK_PREFIX_LENGTH,
  MAX_SIDEBAR_BRAND_IMAGE_DATA_URL_LENGTH,
  MAX_SIDEBAR_BRAND_IMAGE_FILE_BYTES,
  MAX_SIDEBAR_STAR_SPEED,
  MIN_SIDEBAR_STAR_SPEED,
} from "./settings.ts";

const decodeClientSettings = Schema.decodeSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);

describe("client settings", () => {
  it("defaults power-save blocking to off", () => {
    expect(DEFAULT_CLIENT_SETTINGS.powerSaveBlockerMode).toBe(DEFAULT_POWER_SAVE_BLOCKER_MODE);
    expect(decodeClientSettings({}).powerSaveBlockerMode).toBe("off");
  });

  it("defaults appearance preferences", () => {
    expect(DEFAULT_CLIENT_SETTINGS.continueBackgroundAnimations).toBe(
      DEFAULT_CONTINUE_BACKGROUND_ANIMATIONS,
    );
    expect(DEFAULT_CLIENT_SETTINGS.showSidebarMascot).toBe(DEFAULT_SHOW_SIDEBAR_MASCOT);
    expect(DEFAULT_CLIENT_SETTINGS.showSidebarAttribution).toBe(DEFAULT_SHOW_SIDEBAR_ATTRIBUTION);
    expect(DEFAULT_CLIENT_SETTINGS.brandWordmarkPrefix).toBe(DEFAULT_BRAND_WORDMARK_PREFIX);
    expect(DEFAULT_CLIENT_SETTINGS.sidebarBrandImageDataUrl).toBe(
      DEFAULT_SIDEBAR_BRAND_IMAGE_DATA_URL,
    );
    expect(DEFAULT_CLIENT_SETTINGS.sidebarStarSpeed).toBe(DEFAULT_SIDEBAR_STAR_SPEED);
    expect(DEFAULT_CLIENT_SETTINGS.themeAccentColor).toBe(DEFAULT_THEME_ACCENT_COLOR);
    expect(DEFAULT_CLIENT_SETTINGS.appAccentColor).toBe(DEFAULT_APP_ACCENT_COLOR);
    expect(decodeClientSettings({}).continueBackgroundAnimations).toBe(false);
    expect(decodeClientSettings({}).showSidebarMascot).toBe(true);
    expect(decodeClientSettings({}).showSidebarAttribution).toBe(true);
    expect(decodeClientSettings({}).brandWordmarkPrefix).toBe("Cafe");
    expect(decodeClientSettings({}).sidebarBrandImageDataUrl).toBe("");
    expect(decodeClientSettings({}).sidebarStarSpeed).toBe(1);
    expect(decodeClientSettings({}).themeAccentColor).toBe("");
    expect(decodeClientSettings({}).appAccentColor).toBe("");
  });

  it("accepts only supported power-save blocker modes in patches", () => {
    expect(decodeClientSettingsPatch({ powerSaveBlockerMode: "during-chats" })).toEqual({
      powerSaveBlockerMode: "during-chats",
    });
    expect(() => decodeClientSettingsPatch({ powerSaveBlockerMode: "caffeinate" })).toThrow();
  });

  it("trims appearance color patches", () => {
    expect(
      decodeClientSettingsPatch({
        continueBackgroundAnimations: true,
        showSidebarMascot: false,
        showSidebarAttribution: false,
        brandWordmarkPrefix: "  Acme  ",
        sidebarBrandImageDataUrl: "  data:image/png;base64,abc123  ",
        sidebarStarSpeed: 1.5,
        themeAccentColor: "  #16a34a  ",
        appAccentColor: "  #dc2626  ",
      }),
    ).toEqual({
      continueBackgroundAnimations: true,
      showSidebarMascot: false,
      showSidebarAttribution: false,
      brandWordmarkPrefix: "Acme",
      sidebarBrandImageDataUrl: "data:image/png;base64,abc123",
      sidebarStarSpeed: 1.5,
      themeAccentColor: "#16a34a",
      appAccentColor: "#dc2626",
    });
  });

  it("bounds runtime branding settings", () => {
    expect(MAX_SIDEBAR_BRAND_IMAGE_FILE_BYTES).toBe(1_000_000);
    expect(MAX_SIDEBAR_BRAND_IMAGE_DATA_URL_LENGTH).toBeGreaterThanOrEqual(
      Math.ceil((MAX_SIDEBAR_BRAND_IMAGE_FILE_BYTES * 4) / 3) + 128,
    );

    expect(
      decodeClientSettingsPatch({
        brandWordmarkPrefix: "x".repeat(MAX_BRAND_WORDMARK_PREFIX_LENGTH),
        sidebarBrandImageDataUrl: "x".repeat(MAX_SIDEBAR_BRAND_IMAGE_DATA_URL_LENGTH),
        sidebarStarSpeed: MIN_SIDEBAR_STAR_SPEED,
      }),
    ).toEqual({
      brandWordmarkPrefix: "x".repeat(MAX_BRAND_WORDMARK_PREFIX_LENGTH),
      sidebarBrandImageDataUrl: "x".repeat(MAX_SIDEBAR_BRAND_IMAGE_DATA_URL_LENGTH),
      sidebarStarSpeed: MIN_SIDEBAR_STAR_SPEED,
    });

    expect(decodeClientSettingsPatch({ sidebarStarSpeed: MAX_SIDEBAR_STAR_SPEED })).toEqual({
      sidebarStarSpeed: MAX_SIDEBAR_STAR_SPEED,
    });
    expect(() =>
      decodeClientSettingsPatch({ sidebarStarSpeed: MIN_SIDEBAR_STAR_SPEED / 2 }),
    ).toThrow();
    expect(() =>
      decodeClientSettingsPatch({ sidebarStarSpeed: MAX_SIDEBAR_STAR_SPEED * 2 }),
    ).toThrow();
    expect(() =>
      decodeClientSettingsPatch({
        brandWordmarkPrefix: "x".repeat(MAX_BRAND_WORDMARK_PREFIX_LENGTH + 1),
      }),
    ).toThrow();
    expect(() =>
      decodeClientSettingsPatch({
        sidebarBrandImageDataUrl: "x".repeat(MAX_SIDEBAR_BRAND_IMAGE_DATA_URL_LENGTH + 1),
      }),
    ).toThrow();
  });
});
