import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";

import {
  ClientSettingsPatch,
  ClientSettingsSchema,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_CONTINUE_BACKGROUND_ANIMATIONS,
  DEFAULT_POWER_SAVE_BLOCKER_MODE,
  DEFAULT_SHOW_SIDEBAR_MASCOT,
  DEFAULT_THEME_ACCENT_COLOR,
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
    expect(DEFAULT_CLIENT_SETTINGS.themeAccentColor).toBe(DEFAULT_THEME_ACCENT_COLOR);
    expect(decodeClientSettings({}).continueBackgroundAnimations).toBe(false);
    expect(decodeClientSettings({}).showSidebarMascot).toBe(true);
    expect(decodeClientSettings({}).themeAccentColor).toBe("");
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
        themeAccentColor: "  #16a34a  ",
      }),
    ).toEqual({
      continueBackgroundAnimations: true,
      showSidebarMascot: false,
      themeAccentColor: "#16a34a",
    });
  });
});
