import { DEFAULT_CLIENT_SETTINGS } from "@cafecode/contracts/settings";
import { describe, expect, it } from "vitest";
import {
  isWebAppIconUrl,
  localizeWebAppManifestHref,
  parseWebAppBranding,
  parseWebAppIconPath,
  resolveWebAppBranding,
  webAppIconUrl,
  webAppManifestHref,
  webAppManifestIcons,
} from "./webAppBranding.ts";

const id = `sha256-${"a".repeat(64)}.png`;
const asset = {
  id,
  url: `/api/branding/sidebar-image/${id}`,
  mimeType: "image/png" as const,
  width: 800,
  height: 400,
  sizeBytes: 2000,
};
const custom = `custom:${id}` as const;

describe("web application artwork policy", () => {
  it("follows the selected custom source, including legacy auto, and respects hidden/matched artwork", () => {
    const settings = {
      ...DEFAULT_CLIENT_SETTINGS,
      showSidebarMascot: true,
      sidebarBrandImage: asset,
    };
    expect(resolveWebAppBranding({ ...settings, sidebarImageSource: "auto" })).toBe(custom);
    expect(resolveWebAppBranding({ ...settings, sidebarImageSource: "custom" })).toBe(custom);
    expect(resolveWebAppBranding({ ...settings, sidebarImageSource: "match" })).toBe("default");
    expect(resolveWebAppBranding({ ...settings, showSidebarMascot: false })).toBe("neutral");
    expect(resolveWebAppBranding(DEFAULT_CLIENT_SETTINGS)).toBe("neutral");
    expect(
      resolveWebAppBranding({ ...settings, sidebarImageSource: "custom", sidebarBrandImage: null }),
    ).toBe("neutral");
  });

  it("refuses mismatched or noncanonical upload metadata without exposing it in a URL", () => {
    for (const url of [
      "https://foreign.invalid/image.png",
      `//foreign.invalid/${id}`,
      `/api/branding/sidebar-image/${id}?token=secret`,
    ]) {
      expect(
        resolveWebAppBranding({ ...DEFAULT_CLIENT_SETTINGS, sidebarBrandImage: { ...asset, url } }),
      ).toBe("neutral");
    }
    for (const value of [
      null,
      {},
      "custom:../../secret",
      `custom:${id}?token=secret`,
      `custom:sha256-${"a".repeat(64)}.svg`,
    ]) {
      expect(parseWebAppBranding(value)).toBeNull();
    }
    expect(parseWebAppBranding(custom)).toBe(custom);
  });

  it("versions each PNG variant by upload identity and keeps install identity out of icon paths", () => {
    const url = webAppIconUrl(custom, "app-512");
    expect(parseWebAppIconPath(url)).toEqual({ imageId: id, variant: "app-512" });
    expect(webAppIconUrl(`custom:sha256-${"b".repeat(64)}.png`, "app-512")).not.toBe(url);
    expect(webAppManifestIcons(custom).map(({ sizes, purpose }) => ({ sizes, purpose }))).toEqual([
      { sizes: "192x192", purpose: "any" },
      { sizes: "512x512", purpose: "any" },
      { sizes: "512x512", purpose: "maskable" },
    ]);
    for (const value of [
      url + "?token=secret",
      url + "/extra",
      url.replace("app-512", "original"),
      "https://foreign.invalid" + url,
    ]) {
      expect(parseWebAppIconPath(value)).toBeNull();
      expect(isWebAppIconUrl(value)).toBe(false);
    }
  });

  it("preserves the artwork revision through every supported UI language", () => {
    let href = webAppManifestHref("en", custom);
    for (const locale of ["ja", "ko", "en"] as const) {
      href = localizeWebAppManifestHref(href, locale)!;
      expect(href).toBe(webAppManifestHref(locale, custom));
    }
    for (const value of [
      "https://foreign.invalid/manifest.webmanifest",
      "//foreign.invalid/manifest.webmanifest",
      "/manifest.webmanifest#fragment",
      "/manifest.webmanifest?branding=default&token=secret",
      "/manifest.webmanifest?branding=%",
      "/manifest.webmanifest?branding=custom%3Ainvalid",
    ]) {
      expect(localizeWebAppManifestHref(value, "ja")).toBeNull();
    }
  });
});
