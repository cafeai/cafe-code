import { UI_LOCALE, UI_DIRECTION, uiText, type UiLocale } from "./i18n.ts";

/** Public HTML/manifest copy has no renderer/runtime dependency. The extraction
 * task materializes these reviewed strings into the existing inert assets and
 * the build gate rejects stale artifacts. Names, URLs and script remain data. */
export function browserUiCopy(locale: UiLocale = UI_LOCALE) {
  return {
    locale,
    direction: UI_DIRECTION,
    splashLabel: uiText("Cafe Code splash screen", undefined, undefined, locale),
    manifestDescription: uiText(
      "Cafe Code — run and steer coding agents from your browser.",
      undefined,
      undefined,
      locale,
    ),
  } as const;
}
