import { useSyncExternalStore } from "react";
import { getUiLocale } from "@cafecode/shared/i18n";
import {
  WEB_APP_BRANDING_META_NAME,
  isWebAppIconUrl,
  localizeWebAppManifestHref,
  parseWebAppBranding,
  webAppIconUrl,
  webAppManifestHref,
  type WebAppBranding,
} from "@cafecode/shared/webAppBranding";

let branding: WebAppBranding = "neutral";
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => branding;

function setAttribute(element: Element, name: string, value: string): void {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

export function useWebAppBranding(): WebAppBranding {
  return useSyncExternalStore(subscribe, snapshot, () => "neutral");
}

/** Install metadata belongs to the visited origin's primary server. A saved
 * remote workspace's image/bearer never enters this document or its manifest. */
export function applyWebAppBranding(document: Document, next: WebAppBranding): void {
  const marker = document.querySelector(`head > meta[name="${WEB_APP_BRANDING_META_NAME}"]`);
  if (!marker || parseWebAppBranding(next) === null) return;
  setAttribute(marker, "content", next);
  for (const [name, variant] of [
    ["favicon", "favicon-32"],
    ["touch", "touch-180"],
  ] as const) {
    const link = document.querySelector(`head > link[data-cafe-web-icon="${name}"]`);
    if (link && isWebAppIconUrl(link.getAttribute("href") ?? "")) {
      setAttribute(link, "href", webAppIconUrl(next, variant));
    }
  }
  const manifest = document.querySelector('head > link[rel="manifest"]');
  if (
    manifest &&
    localizeWebAppManifestHref(manifest.getAttribute("href") ?? "", getUiLocale()) !== null
  ) {
    setAttribute(manifest, "href", webAppManifestHref(getUiLocale(), next));
  }
  const bootLogo = document.querySelector(
    "body > #root > #boot-shell > #boot-shell-card > #boot-shell-logo",
  );
  if (bootLogo && isWebAppIconUrl(bootLogo.getAttribute("src") ?? "")) {
    setAttribute(bootLogo, "src", webAppIconUrl(next, "touch-180"));
  }
  if (branding !== next) {
    branding = next;
    for (const listener of listeners) listener();
  }
}

/** The server supplies only a finite presentation token after request auth;
 * no preference request, local cache, provider startup or extra wait is needed. */
export function initializeWebAppBranding(document: Document): void {
  const token =
    parseWebAppBranding(
      document
        .querySelector(`head > meta[name="${WEB_APP_BRANDING_META_NAME}"]`)
        ?.getAttribute("content"),
    ) ?? "neutral";
  applyWebAppBranding(document, token);
}
