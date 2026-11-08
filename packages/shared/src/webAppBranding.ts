import type { ClientSettings } from "@cafecode/contracts/settings";

/** Version the derived bytes' URLs whenever their rendering policy changes. */
export const WEB_APP_ICON_PREFIX = "/api/branding/app-icon/v1/";
export const WEB_APP_NEUTRAL_ICON_PREFIX = "/app-branding/neutral-v1/";
export const WEB_APP_BRANDING_META_NAME = "cafe-code-web-branding";
export const WEB_APP_ICON_VARIANTS = [
  "touch-180",
  "app-192",
  "app-512",
  "maskable-512",
  "favicon-32",
  "badge-96",
] as const;
export type WebAppIconVariant = (typeof WEB_APP_ICON_VARIANTS)[number];
export type WebAppBranding = "neutral" | "default" | `custom:${string}`;

const IMAGE_ID = /^sha256-[a-f0-9]{64}\.(?:gif|jpe?g|png|webp)$/;
const MANIFEST_PATH = /^\/manifest(?:\.(ja|ko))?\.webmanifest$/;

export function parseWebAppBranding(value: unknown): WebAppBranding | null {
  if (value === "neutral" || value === "default") return value;
  return typeof value === "string" &&
    value.length <= 104 &&
    value.startsWith("custom:") &&
    IMAGE_ID.test(value.slice(7))
    ? (value as WebAppBranding)
    : null;
}

/** This is presentation only; neither an image id nor a URL grants image access. */
export function resolveWebAppBranding(
  settings: Pick<ClientSettings, "showSidebarMascot" | "sidebarImageSource" | "sidebarBrandImage">,
): WebAppBranding {
  if (!settings.showSidebarMascot) return "neutral";
  const custom =
    settings.sidebarImageSource === "custom" ||
    (settings.sidebarImageSource === "auto" && settings.sidebarBrandImage !== null);
  if (!custom) return "default";
  const asset = settings.sidebarBrandImage;
  return asset && IMAGE_ID.test(asset.id) && asset.url === `/api/branding/sidebar-image/${asset.id}`
    ? `custom:${asset.id}`
    : "neutral";
}

export function webAppIconUrl(branding: WebAppBranding, variant: WebAppIconVariant): string {
  if (branding.startsWith("custom:")) {
    return `${WEB_APP_ICON_PREFIX}${branding.slice(7)}/${variant}.png`;
  }
  if (branding === "neutral") return `${WEB_APP_NEUTRAL_ICON_PREFIX}${variant}.png`;
  switch (variant) {
    case "touch-180":
      return "/apple-touch-icon.png";
    case "app-192":
      return "/icon-192.png";
    case "app-512":
      return "/icon-512.png";
    case "maskable-512":
      return "/icon-maskable-512.png";
    case "favicon-32":
    case "badge-96":
      return "/favicon-32x32.png";
  }
}

export function webAppManifestIcons(branding: WebAppBranding) {
  return [
    {
      src: webAppIconUrl(branding, "app-192"),
      sizes: "192x192",
      type: "image/png",
      purpose: "any",
    },
    {
      src: webAppIconUrl(branding, "app-512"),
      sizes: "512x512",
      type: "image/png",
      purpose: "any",
    },
    {
      src: webAppIconUrl(branding, "maskable-512"),
      sizes: "512x512",
      type: "image/png",
      purpose: "maskable",
    },
  ];
}

export function parseWebAppIconPath(pathname: string): {
  imageId: string;
  variant: WebAppIconVariant;
} | null {
  if (!pathname.startsWith(WEB_APP_ICON_PREFIX)) return null;
  const parts = pathname.slice(WEB_APP_ICON_PREFIX.length).split("/");
  if (parts.length !== 2 || !IMAGE_ID.test(parts[0] ?? "")) return null;
  const variant = WEB_APP_ICON_VARIANTS.find((entry) => `${entry}.png` === parts[1]);
  return variant ? { imageId: parts[0]!, variant } : null;
}

export function isWebAppIconUrl(value: string): boolean {
  return (
    parseWebAppIconPath(value) !== null ||
    WEB_APP_ICON_VARIANTS.some(
      (variant) =>
        value === webAppIconUrl("default", variant) || value === webAppIconUrl("neutral", variant),
    )
  );
}

export function webAppManifestHref(locale: "en" | "ja" | "ko", branding?: WebAppBranding): string {
  const pathname = locale === "en" ? "/manifest.webmanifest" : `/manifest.${locale}.webmanifest`;
  return branding === undefined ? pathname : `${pathname}?branding=${encodeURIComponent(branding)}`;
}

/** Preserve the finite branding revision across language changes, never external links. */
export function localizeWebAppManifestHref(
  href: string,
  locale: "en" | "ja" | "ko",
): string | null {
  const parts = href.split("?");
  if (parts.length > 2 || !MANIFEST_PATH.test(parts[0] ?? "")) return null;
  if (parts.length === 1) return webAppManifestHref(locale);
  const query = parts[1]!;
  if (!query.startsWith("branding=")) return null;
  let branding: WebAppBranding | null;
  try {
    branding = parseWebAppBranding(decodeURIComponent(query.slice(9)));
  } catch {
    return null;
  }
  return branding && query === `branding=${encodeURIComponent(branding)}`
    ? webAppManifestHref(locale, branding)
    : null;
}
