import * as Schema from "effect/Schema";
import {
  WEB_APP_BRANDING_META_NAME,
  isWebAppIconUrl,
  localizeWebAppManifestHref,
  parseWebAppBranding,
  webAppIconUrl,
  webAppManifestHref,
  webAppManifestIcons,
  type WebAppBranding,
} from "@cafecode/shared/webAppBranding";

const decodeManifest = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const encodeManifest = Schema.encodeSync(Schema.UnknownFromJsonString);

/** Only exact Cafe-owned slots are rewritten; synthetic/unrecognized HTML stays untouched. */
export function brandWebAppHtml(html: string, branding: WebAppBranding): string | null {
  const marker = new RegExp(
    `<meta\\s+name="${WEB_APP_BRANDING_META_NAME}"\\s+content="neutral"\\s*/?>`,
  );
  if (!marker.test(html) || parseWebAppBranding(branding) === null) return null;
  const touch = webAppIconUrl(branding, "touch-180");
  const favicon = webAppIconUrl(branding, "favicon-32");
  return html
    .replace(marker, `<meta name="${WEB_APP_BRANDING_META_NAME}" content="${branding}" />`)
    .replace(/<link\b[^>]*>/g, (tag) => {
      const rel = /\brel="([^"]*)"/.exec(tag)?.[1];
      const original = /\bhref="([^"]*)"/.exec(tag)?.[1] ?? "";
      const slot = /\bdata-cafe-web-icon="([^"]*)"/.exec(tag)?.[1];
      const href =
        rel === "icon" && slot === "favicon" && isWebAppIconUrl(original)
          ? favicon
          : rel === "apple-touch-icon" && slot === "touch" && isWebAppIconUrl(original)
            ? touch
            : rel === "manifest" && localizeWebAppManifestHref(original, "en") !== null
              ? webAppManifestHref("en", branding)
              : null;
      return href === null ? tag : tag.replace(/\bhref="[^"]*"/, `href="${href}"`);
    })
    .replace(/<img\b[^>]*\bid="boot-shell-logo"[^>]*>/, (tag) => {
      const original = /\bsrc="([^"]*)"/.exec(tag)?.[1] ?? "";
      return isWebAppIconUrl(original) ? tag.replace(/\bsrc="[^"]*"/, `src="${touch}"`) : tag;
    });
}

export function brandWebAppManifest(
  contents: string,
  branding: WebAppBranding,
  icons = webAppManifestIcons(branding),
): string | null {
  if (parseWebAppBranding(branding) === null) return null;
  const decoded = decodeManifest(contents);
  if (decoded._tag === "None") return null;
  const manifest = decoded.value;
  if (
    manifest.id !== "/" ||
    manifest.scope !== "/" ||
    manifest.start_url !== "/" ||
    manifest.name !== "Cafe Code" ||
    !Array.isArray(manifest.icons)
  )
    return null;
  return encodeManifest({ ...manifest, icons });
}
