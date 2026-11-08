import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import {
  webAppIconUrl,
  webAppManifestHref,
  webAppManifestIcons,
  type WebAppBranding,
} from "@cafecode/shared/webAppBranding";
import { brandWebAppHtml, brandWebAppManifest } from "./webAppBranding.ts";

const custom = `custom:sha256-${"a".repeat(64)}.png` as const;
const shell = `<html><head>
  <meta name="cafe-code-web-branding" content="neutral" />
  <link rel="icon" href="/app-branding/neutral-v1/favicon-32.png" data-cafe-web-icon="favicon" />
  <link rel="apple-touch-icon" href="/app-branding/neutral-v1/touch-180.png" data-cafe-web-icon="touch" />
  <link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials" />
  <link rel="icon" href="https://foreign.invalid/opaque.png" />
  </head><body><img id="boot-shell-logo" src="/app-branding/neutral-v1/touch-180.png" />
  <script type="module" src="/assets/main.js"></script></body></html>`;
const manifest = {
  name: "Cafe Code",
  short_name: "Cafe Code",
  id: "/",
  start_url: "/",
  scope: "/",
  display: "standalone",
  lang: "ja",
  description: "日本語",
  icons: [],
};
const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString);
const decodeJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

describe("server-owned web branding documents", () => {
  it("puts the saved choice into the first HTML bytes and only rewrites owned slots", () => {
    const output = brandWebAppHtml(shell, custom)!;
    expect(output).toContain(`content="${custom}"`);
    expect(output).toContain(`href="${webAppIconUrl(custom, "favicon-32")}"`);
    expect(output).toContain(`src="${webAppIconUrl(custom, "touch-180")}"`);
    expect(output).toContain(
      `href="${webAppManifestHref("en", custom)}" crossorigin="use-credentials"`,
    );
    expect(output).toContain('<link rel="icon" href="https://foreign.invalid/opaque.png" />');
    expect(output).toContain('<script type="module" src="/assets/main.js"></script>');
    expect(brandWebAppHtml("<html>unrecognized</html>", custom)).toBeNull();
    expect(brandWebAppHtml(shell, "custom:<script>" as WebAppBranding)).toBeNull();
  });

  it("keeps anonymous/hidden artwork neutral and uses the normal bundled image only for an explicit default", () => {
    expect(brandWebAppHtml(shell, "neutral")).not.toContain("apple-touch-icon.png");
    expect(brandWebAppHtml(shell, "default")).toContain('src="/apple-touch-icon.png"');
  });

  it("preserves manifest identity and localization while installing supplied derived PNGs", () => {
    const icons = webAppManifestIcons(custom).map((icon) => ({
      ...icon,
      src: "data:image/png;base64,derived",
    }));
    const output = decodeJson(brandWebAppManifest(encodeJson(manifest), custom, icons)!);
    expect(output).toEqual({ ...manifest, icons });
    expect(brandWebAppManifest('{"name":"Other app"}', custom)).toBeNull();
    expect(brandWebAppManifest("malformed", custom)).toBeNull();
    expect(brandWebAppManifest(encodeJson({ ...manifest, id: "/another-app" }), custom)).toBeNull();
  });
});
