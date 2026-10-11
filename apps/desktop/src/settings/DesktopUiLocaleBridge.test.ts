import { describe, expect, it } from "vitest";
import {
  desktopUiLocaleArguments,
  isDesktopUiLocale,
  readDesktopUiLocaleArguments,
} from "./DesktopUiLocaleBridge.ts";

describe("finite desktop locale presentation bridge", () => {
  it.each(["en", "ja", "ko"] as const)(
    "round trips %s without importing arbitrary catalogs",
    (locale) => {
      expect(readDesktopUiLocaleArguments(desktopUiLocaleArguments(locale, "en"))).toEqual({
        systemUiLocale: locale,
        initialUiLocale: "en",
      });
    },
  );
  it("rejects ambiguous, oversized and unknown arguments independently", () => {
    expect(
      readDesktopUiLocaleArguments([
        "--cafe-system-ui-locale=ja",
        "--cafe-system-ui-locale=ko",
        "--cafe-initial-ui-locale=../../secret",
      ]),
    ).toEqual({ systemUiLocale: "en", initialUiLocale: "en" });
    expect(
      readDesktopUiLocaleArguments([
        "--cafe-system-ui-locale=" + "a".repeat(20_000),
        "--cafe-initial-ui-locale=ko",
      ]),
    ).toEqual({ systemUiLocale: "en", initialUiLocale: "ko" });
    expect(readDesktopUiLocaleArguments([])).toEqual({
      systemUiLocale: "en",
      initialUiLocale: "en",
    });
    for (const raw of [null, {}, [], "system", "JA", "ja-JP", 1])
      expect(isDesktopUiLocale(raw)).toBe(false);
  });
});
