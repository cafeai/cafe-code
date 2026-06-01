export const CAFE_CODE_LINUX_PASSWORD_STORE_ENV = "CAFE_CODE_LINUX_PASSWORD_STORE";

const LIBSECRET_DESKTOP_HINTS = [
  "x-cinnamon",
  "deepin",
  "gnome",
  "pantheon",
  "xfce",
  "ukui",
  "unity",
];

function normalize(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function desktopHints(environment: NodeJS.ProcessEnv): Array<string> {
  return [
    environment.XDG_CURRENT_DESKTOP,
    environment.XDG_SESSION_DESKTOP,
    environment.DESKTOP_SESSION,
  ]
    .map(normalize)
    .filter((value) => value.length > 0);
}

export function resolveLinuxSafeStoragePasswordStore(
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const explicit = environment[CAFE_CODE_LINUX_PASSWORD_STORE_ENV]?.trim();
  if (explicit) {
    return explicit === "auto" ? undefined : explicit;
  }

  if (environment.KDE_SESSION_VERSION?.trim() === "5") {
    return "kwallet5";
  }

  const hints = desktopHints(environment);
  if (
    environment.KDE_FULL_SESSION === "true" ||
    hints.some((value) => value.includes("kde") || value.includes("plasma"))
  ) {
    return "kwallet6";
  }

  if (hints.some((value) => LIBSECRET_DESKTOP_HINTS.some((desktop) => value.includes(desktop)))) {
    return "gnome-libsecret";
  }

  return undefined;
}
