import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as i18n from "./i18n.ts";
import {
  createDesktopStartupDocument,
  desktopStartupCopy,
  DESKTOP_STARTUP_STYLE,
} from "./desktopStartupDocument.ts";

const styleHash = createHash("sha256").update(DESKTOP_STARTUP_STYLE).digest("base64");
afterEach(() => {
  vi.restoreAllMocks();
  i18n.setUiLocale("en");
});

describe("localized inert desktop startup document", () => {
  it.each(["en", "ja", "ko"] as const)(
    "renders trusted %s copy and metadata without any script/network bridge",
    (locale) => {
      i18n.setUiLocale(locale);
      const html = createDesktopStartupDocument("migrating", styleHash);
      expect(html).toContain(`<html lang="${locale}" dir="ltr">`);
      expect(html).toContain(i18n.getUiTranslator(locale).text("Updating your workspace…"));
      expect(html).toContain(`style-src 'sha256-${styleHash}'`);
      expect(html).toContain("connect-src 'none'");
      expect(html).not.toContain("<script");
    },
  );
  it("preserves phase copy, English locale and exact restrictive stylesheet policy", () => {
    expect(desktopStartupCopy("starting")).toEqual({ label: "Starting…", detail: "" });
    expect(desktopStartupCopy("ready")).toEqual({ label: "Opening your workspace…", detail: "" });
    const html = createDesktopStartupDocument("migrating", styleHash);
    expect(html).toContain('<html lang="en" dir="ltr">');
    expect(html).toContain("Updating your workspace…");
    expect(html).toContain("Large workspaces can take a while. Your chats stay saved.");
    expect(html).toContain(`style-src 'sha256-${styleHash}'`);
    expect(html).toContain(
      "script-src 'none'; connect-src 'none'; img-src 'none'; font-src 'none'",
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("href=");
  });

  it("escapes complete catalog text instead of giving translations markup authority", () => {
    vi.spyOn(i18n, "uiText").mockReturnValue(`&<script src="bad">'hello'</script>`);
    const html = createDesktopStartupDocument("migrating", styleHash);
    expect(html).toContain("&amp;&lt;script src=&quot;bad&quot;&gt;&#39;hello&#39;&lt;/script&gt;");
    expect(html).not.toContain('<script src="bad">');
    expect(html.match(/<style>/g)).toHaveLength(1);
    expect(html).toContain(`style-src 'sha256-${styleHash}'`);
  });

  it("refuses an injected stylesheet policy delimiter", () => {
    expect(() => createDesktopStartupDocument("starting", "bad'; script-src *")).toThrow(
      "Invalid startup stylesheet identity.",
    );
  });
});
