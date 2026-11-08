import type { DesktopAppIconVariant } from "@cafecode/contracts";

import type { SidebarImageColorId, SidebarImageTheme } from "./sidebarImages";

/**
 * The built-in app icons (Default and the unlockable Dekai) recolored for each
 * accent-color scene and theme. Only the background changes; the character is
 * pixel-identical across all 32 so the icon never looks like a different app.
 */

// Eager URL imports: only an icon actually shown or rendered is fetched.
const APP_ICON_URLS = import.meta.glob<string>("./assets/app-icons/*.webp", {
  eager: true,
  query: "?url",
  import: "default",
});

/** Rendered app icons are this many pixels square (512 keeps the Dock sharp). */
export const THEMED_APP_ICON_SIZE = 512;

export function themedAppIconKey(
  variant: DesktopAppIconVariant,
  color: SidebarImageColorId,
  theme: SidebarImageTheme,
): string {
  return `${variant}-${color}-${theme}`;
}

export function themedAppIconUrl(
  variant: DesktopAppIconVariant,
  color: SidebarImageColorId,
  theme: SidebarImageTheme,
): string {
  const url = APP_ICON_URLS[`./assets/app-icons/${themedAppIconKey(variant, color, theme)}.webp`];
  if (!url) throw new Error(`Missing built-in app icon ${variant}-${color}-${theme}.`);
  return url;
}
