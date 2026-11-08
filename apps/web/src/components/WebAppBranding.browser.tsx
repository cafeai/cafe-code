import { afterEach, describe, expect, it } from "vitest";
import { getUiLocale, setUiLocale } from "@cafecode/shared/i18n";
import {
  webAppIconUrl,
  webAppManifestHref,
  type WebAppBranding,
} from "@cafecode/shared/webAppBranding";
import { initializeUiLocale } from "../i18n";
import { applyWebAppBranding, initializeWebAppBranding } from "../webAppBranding";

const originalLocale = getUiLocale();
const custom = `custom:sha256-${"a".repeat(64)}.png` as const;

function fixture(branding: WebAppBranding = "neutral") {
  // A detached native document makes no requests and owns no active render or
  // platform session. Received/external-looking nodes remain outside its slots.
  const isolated = document.implementation.createHTMLDocument("App branding");
  isolated.head.innerHTML = `<meta name="cafe-code-web-branding" content="${branding}" />
    <link rel="icon" href="${webAppIconUrl(branding, "favicon-32")}" data-cafe-web-icon="favicon" />
    <link rel="apple-touch-icon" href="${webAppIconUrl(branding, "touch-180")}" data-cafe-web-icon="touch" />
    <link rel="manifest" href="${webAppManifestHref("en", branding)}" crossorigin="use-credentials" />
    <link rel="icon" href="https://foreign.invalid/image.png" data-unrelated="true" />`;
  isolated.body.innerHTML = `<div id="root"><div id="boot-shell"><div id="boot-shell-card"><img id="boot-shell-logo" src="${webAppIconUrl(branding, "touch-180")}" /></div></div></div>`;
  return isolated;
}

afterEach(() => {
  setUiLocale(originalLocale);
  applyWebAppBranding(fixture(), "neutral");
});

describe("web branding startup and live metadata", () => {
  it("adopts the server's saved token before settings hydrate and updates every owned slot together", () => {
    setUiLocale("en");
    const isolated = fixture(custom);
    initializeWebAppBranding(isolated);
    expect(isolated.querySelector('link[rel="icon"]')?.getAttribute("href")).toBe(
      webAppIconUrl(custom, "favicon-32"),
    );
    expect(isolated.querySelector("#boot-shell-logo")?.getAttribute("src")).toBe(
      webAppIconUrl(custom, "touch-180"),
    );
    const replacement = `custom:sha256-${"b".repeat(64)}.jpg` as const;
    applyWebAppBranding(isolated, replacement);
    expect(
      isolated.querySelector('meta[name="cafe-code-web-branding"]')?.getAttribute("content"),
    ).toBe(replacement);
    expect(isolated.querySelector('link[data-cafe-web-icon="favicon"]')?.getAttribute("href")).toBe(
      webAppIconUrl(replacement, "favicon-32"),
    );
    expect(isolated.querySelector('link[data-cafe-web-icon="touch"]')?.getAttribute("href")).toBe(
      webAppIconUrl(replacement, "touch-180"),
    );
    expect(isolated.querySelector("#boot-shell-logo")?.getAttribute("src")).toBe(
      webAppIconUrl(replacement, "touch-180"),
    );
    expect(isolated.querySelector('link[data-unrelated="true"]')?.getAttribute("href")).toBe(
      "https://foreign.invalid/image.png",
    );
    const manifest = isolated.querySelector('link[rel="manifest"]')!;
    for (const locale of ["ja", "ko", "en"] as const) {
      setUiLocale(locale);
      initializeUiLocale(isolated);
      expect(manifest.getAttribute("href")).toBe(webAppManifestHref(locale, replacement));
      expect(manifest.getAttribute("crossorigin")).toBe("use-credentials");
    }
    applyWebAppBranding(isolated, "neutral");
    expect(isolated.querySelector("#boot-shell-logo")?.getAttribute("src")).toBe(
      webAppIconUrl("neutral", "touch-180"),
    );
  });

  it("leaves external manifests and unknown documents alone", () => {
    const isolated = fixture();
    const manifest = isolated.querySelector('link[rel="manifest"]')!;
    manifest.setAttribute("href", "https://foreign.invalid/manifest.webmanifest");
    applyWebAppBranding(isolated, custom);
    expect(manifest.getAttribute("href")).toBe("https://foreign.invalid/manifest.webmanifest");
    const unknown = document.implementation.createHTMLDocument("No branding slots");
    const before = unknown.documentElement.outerHTML;
    initializeWebAppBranding(unknown);
    expect(unknown.documentElement.outerHTML).toBe(before);
  });
});
