import type { UiLocale } from "@cafecode/shared/i18n";

/** Finite presentation metadata, never a path, locale import or IPC command. */
export const DESKTOP_UI_LOCALE_CHANGED_CHANNEL = "cafe:ui-locale-changed";
const SYSTEM_ARGUMENT = "--cafe-system-ui-locale=";
const INITIAL_ARGUMENT = "--cafe-initial-ui-locale=";

export function isDesktopUiLocale(value: unknown): value is UiLocale {
  return value === "en" || value === "ja" || value === "ko";
}

export function desktopUiLocaleArguments(system: UiLocale, initial: UiLocale): string[] {
  return [`${SYSTEM_ARGUMENT}${system}`, `${INITIAL_ARGUMENT}${initial}`];
}

export function readDesktopUiLocaleArguments(args: readonly string[]): {
  readonly systemUiLocale: UiLocale;
  readonly initialUiLocale: UiLocale;
} {
  const read = (prefix: string): UiLocale => {
    const matches = args.filter((arg) => arg.startsWith(prefix));
    // Ambiguous or malformed arguments cannot select arbitrary translation
    // data. Do not interpret a later duplicate as privileged overriding data.
    if (matches.length !== 1) return "en";
    const value = matches[0]!.slice(prefix.length);
    return isDesktopUiLocale(value) ? value : "en";
  };
  return { systemUiLocale: read(SYSTEM_ARGUMENT), initialUiLocale: read(INITIAL_ARGUMENT) };
}
