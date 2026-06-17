import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";

import {
  ClientSettingsPatch,
  ClientSettingsSchema,
  CLIENT_SETTINGS_CAPABILITY_DEPENDENT_KEYS,
  CLIENT_SETTINGS_EXCLUDED_SECRET_STORES,
  CLIENT_SETTINGS_KEYS,
  DEFAULT_APP_ACCENT_COLOR,
  DEFAULT_BRAND_WORDMARK_PREFIX,
  DEFAULT_CHAT_COPY_FORMAT,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_CONTINUE_BACKGROUND_ANIMATIONS,
  DEFAULT_POWER_SAVE_BLOCKER_MODE,
  DEFAULT_SHOW_SIDEBAR_ATTRIBUTION,
  DEFAULT_SIDEBAR_BRAND_IMAGE_DATA_URL,
  DEFAULT_SIDEBAR_BRAND_IMAGE,
  DEFAULT_SIDEBAR_STAR_SPEED,
  DEFAULT_SHOW_SIDEBAR_MASCOT,
  DEFAULT_SHOW_SIDEBAR_SEARCH,
  DEFAULT_THEME_ACCENT_COLOR,
  MAX_BRAND_WORDMARK_PREFIX_LENGTH,
  MAX_SIDEBAR_BRAND_IMAGE_DATA_URL_LENGTH,
  MAX_SIDEBAR_BRAND_IMAGE_FILE_BYTES,
  MAX_SIDEBAR_BRAND_IMAGE_ID_LENGTH,
  MAX_SIDEBAR_STAR_SPEED,
  MIN_SIDEBAR_STAR_SPEED,
  isCapabilityDependentClientSettingsKey,
  isClientSettingsKey,
} from "./settings.ts";

const decodeClientSettings = Schema.decodeSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);

describe("client settings", () => {
  it("defaults power-save blocking to off", () => {
    expect(DEFAULT_CLIENT_SETTINGS.powerSaveBlockerMode).toBe(DEFAULT_POWER_SAVE_BLOCKER_MODE);
    expect(decodeClientSettings({}).powerSaveBlockerMode).toBe("off");
  });

  it("defaults chat selection copy to Markdown", () => {
    expect(DEFAULT_CLIENT_SETTINGS.chatCopyFormat).toBe(DEFAULT_CHAT_COPY_FORMAT);
    expect(decodeClientSettings({}).chatCopyFormat).toBe("markdown");
  });

  it("accepts only supported chat copy formats in patches", () => {
    expect(decodeClientSettingsPatch({ chatCopyFormat: "plainText" })).toEqual({
      chatCopyFormat: "plainText",
    });
    expect(() => decodeClientSettingsPatch({ chatCopyFormat: "html" })).toThrow();
  });

  it("exposes every client setting through ClientSettingsPatch", () => {
    // A settings key that exists in ClientSettingsSchema but not in
    // ClientSettingsPatch can never be saved: the update RPC decodes the patch
    // against ClientSettingsPatch and silently drops unknown keys, so the
    // toggle flips and snaps back. Keys updated through their own dedicated
    // flow rather than the generic patch RPC are allowlisted here.
    const NON_PATCHABLE_KEYS = new Set(["dismissedProviderUpdateNotificationKeys"]);
    const patchKeys = new Set(Object.keys(ClientSettingsPatch.fields));
    const missing = Object.keys(ClientSettingsSchema.fields).filter(
      (key) => !patchKeys.has(key) && !NON_PATCHABLE_KEYS.has(key),
    );
    expect(missing).toEqual([]);
  });

  it("classifies synced client settings without including secret stores", () => {
    expect(CLIENT_SETTINGS_KEYS).toContain("sidebarBrandImageDataUrl");
    expect(CLIENT_SETTINGS_KEYS).toContain("sidebarBrandImage");
    expect(CLIENT_SETTINGS_KEYS).toContain("defaultEditor");
    expect(CLIENT_SETTINGS_KEYS).toContain("powerSaveBlockerMode");
    expect(isClientSettingsKey("sidebarBrandImageDataUrl")).toBe(true);
    expect(isClientSettingsKey("sidebarBrandImage")).toBe(true);
    expect(isClientSettingsKey("providerCredentials")).toBe(false);
    expect(CLIENT_SETTINGS_EXCLUDED_SECRET_STORES).toContain("provider-api-keys");
    expect(CLIENT_SETTINGS_EXCLUDED_SECRET_STORES).toContain("tls-private-keys");
  });

  it("marks capability-dependent preferences without excluding them from sync", () => {
    expect(CLIENT_SETTINGS_CAPABILITY_DEPENDENT_KEYS).toEqual([
      "defaultEditor",
      "powerSaveBlockerMode",
    ]);
    expect(isCapabilityDependentClientSettingsKey("defaultEditor")).toBe(true);
    expect(isCapabilityDependentClientSettingsKey("powerSaveBlockerMode")).toBe(true);
    expect(CLIENT_SETTINGS_KEYS).toContain("defaultEditor");
    expect(CLIENT_SETTINGS_KEYS).toContain("powerSaveBlockerMode");
  });

  it("defaults appearance preferences", () => {
    expect(DEFAULT_CLIENT_SETTINGS.continueBackgroundAnimations).toBe(
      DEFAULT_CONTINUE_BACKGROUND_ANIMATIONS,
    );
    expect(DEFAULT_CLIENT_SETTINGS.showSidebarSearch).toBe(DEFAULT_SHOW_SIDEBAR_SEARCH);
    expect(DEFAULT_CLIENT_SETTINGS.showSidebarMascot).toBe(DEFAULT_SHOW_SIDEBAR_MASCOT);
    expect(DEFAULT_CLIENT_SETTINGS.showSidebarAttribution).toBe(DEFAULT_SHOW_SIDEBAR_ATTRIBUTION);
    expect(DEFAULT_CLIENT_SETTINGS.brandWordmarkPrefix).toBe(DEFAULT_BRAND_WORDMARK_PREFIX);
    expect(DEFAULT_CLIENT_SETTINGS.sidebarBrandImage).toBe(DEFAULT_SIDEBAR_BRAND_IMAGE);
    expect(DEFAULT_CLIENT_SETTINGS.sidebarBrandImageDataUrl).toBe(
      DEFAULT_SIDEBAR_BRAND_IMAGE_DATA_URL,
    );
    expect(DEFAULT_CLIENT_SETTINGS.sidebarStarSpeed).toBe(DEFAULT_SIDEBAR_STAR_SPEED);
    expect(DEFAULT_CLIENT_SETTINGS.themeAccentColor).toBe(DEFAULT_THEME_ACCENT_COLOR);
    expect(DEFAULT_CLIENT_SETTINGS.appAccentColor).toBe(DEFAULT_APP_ACCENT_COLOR);
    expect(decodeClientSettings({}).continueBackgroundAnimations).toBe(false);
    expect(decodeClientSettings({}).showSidebarSearch).toBe(true);
    expect(decodeClientSettings({}).showSidebarMascot).toBe(true);
    expect(decodeClientSettings({}).showSidebarAttribution).toBe(true);
    expect(decodeClientSettings({}).brandWordmarkPrefix).toBe("Cafe");
    expect(decodeClientSettings({}).sidebarBrandImage).toBeNull();
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
        showSidebarSearch: false,
        showSidebarMascot: false,
        showSidebarAttribution: false,
        brandWordmarkPrefix: "  Acme  ",
        sidebarBrandImage: {
          id: "sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
          url: "/api/branding/sidebar-image/sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
          mimeType: "image/png",
          width: 128,
          height: 160,
          sizeBytes: 12345,
        },
        sidebarBrandImageDataUrl: "  data:image/png;base64,abc123  ",
        sidebarStarSpeed: 1.5,
        themeAccentColor: "  #16a34a  ",
        appAccentColor: "  #dc2626  ",
      }),
    ).toEqual({
      continueBackgroundAnimations: true,
      showSidebarSearch: false,
      showSidebarMascot: false,
      showSidebarAttribution: false,
      brandWordmarkPrefix: "Acme",
      sidebarBrandImage: {
        id: "sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
        url: "/api/branding/sidebar-image/sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
        mimeType: "image/png",
        width: 128,
        height: 160,
        sizeBytes: 12345,
      },
      sidebarBrandImageDataUrl: "data:image/png;base64,abc123",
      sidebarStarSpeed: 1.5,
      themeAccentColor: "#16a34a",
      appAccentColor: "#dc2626",
    });
  });

  it("bounds runtime branding settings", () => {
    expect(MAX_SIDEBAR_BRAND_IMAGE_FILE_BYTES).toBe(1_000_000);
    expect(MAX_SIDEBAR_BRAND_IMAGE_ID_LENGTH).toBe(96);
    expect(MAX_SIDEBAR_BRAND_IMAGE_DATA_URL_LENGTH).toBeGreaterThanOrEqual(
      Math.ceil((MAX_SIDEBAR_BRAND_IMAGE_FILE_BYTES * 4) / 3) + 128,
    );

    expect(
      decodeClientSettingsPatch({
        brandWordmarkPrefix: "x".repeat(MAX_BRAND_WORDMARK_PREFIX_LENGTH),
        sidebarBrandImage: {
          id: "sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.webp",
          url: "/api/branding/sidebar-image/sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.webp",
          mimeType: "image/webp",
          width: 4096,
          height: 4096,
          sizeBytes: MAX_SIDEBAR_BRAND_IMAGE_FILE_BYTES,
        },
        sidebarBrandImageDataUrl: "x".repeat(MAX_SIDEBAR_BRAND_IMAGE_DATA_URL_LENGTH),
        sidebarStarSpeed: MIN_SIDEBAR_STAR_SPEED,
      }),
    ).toEqual({
      brandWordmarkPrefix: "x".repeat(MAX_BRAND_WORDMARK_PREFIX_LENGTH),
      sidebarBrandImage: {
        id: "sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.webp",
        url: "/api/branding/sidebar-image/sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.webp",
        mimeType: "image/webp",
        width: 4096,
        height: 4096,
        sizeBytes: MAX_SIDEBAR_BRAND_IMAGE_FILE_BYTES,
      },
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
    expect(() =>
      decodeClientSettingsPatch({
        sidebarBrandImage: {
          id: "brand.png",
          url: "/api/branding/sidebar-image/brand.png",
          mimeType: "image/png",
          width: 128,
          height: 160,
          sizeBytes: 1024,
        },
      }),
    ).toThrow();
    expect(() =>
      decodeClientSettingsPatch({
        sidebarBrandImage: {
          id: "sha256-cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc.png",
          url: "/api/branding/sidebar-image/sha256-cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc.png",
          mimeType: "image/svg+xml",
          width: 128,
          height: 160,
          sizeBytes: 1024,
        },
      }),
    ).toThrow();
    expect(() =>
      decodeClientSettingsPatch({
        sidebarBrandImage: {
          id: "sha256-dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd.png",
          url: "/api/branding/sidebar-image/sha256-dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd.png",
          mimeType: "image/png",
          width: 4097,
          height: 160,
          sizeBytes: 1024,
        },
      }),
    ).toThrow();
  });

  it("decodes legacy data URL settings alongside compact branding metadata", () => {
    expect(
      decodeClientSettings({
        sidebarBrandImageDataUrl: "data:image/png;base64,abc123",
      }).sidebarBrandImageDataUrl,
    ).toBe("data:image/png;base64,abc123");

    expect(
      decodeClientSettings({
        sidebarBrandImage: {
          id: "sha256-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.jpg",
          url: "/api/branding/sidebar-image/sha256-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.jpg",
          mimeType: "image/jpeg",
          width: 320,
          height: 400,
          sizeBytes: 2048,
        },
      }).sidebarBrandImageDataUrl,
    ).toBe("");
  });
});
