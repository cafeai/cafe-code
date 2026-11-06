import type {
  DesktopAppIconState,
  DesktopAppIconVariant,
  DesktopThemedAppIcon,
  SetDesktopAppIconInput,
} from "@cafecode/contracts";
import { useEffect, useSyncExternalStore } from "react";

import { renderAppIconPngs } from "./appIconRendering";
import { THEMED_APP_ICON_SIZE, themedAppIconKey, themedAppIconUrl } from "./appIconThemes";
import { useSettings } from "./hooks/useSettings";
import { useTheme } from "./hooks/useTheme";
import {
  resolveSidebarImageColor,
  type SidebarImageColorId,
  type SidebarImageTheme,
} from "./sidebarImages";

/**
 * This computer's app icon (desktop app only), shared by Settings → App icon
 * and the background sync that recolors the icon with the accent color and
 * theme. The desktop main process stays authoritative; this only caches its
 * last answer so both consumers agree.
 */

let current: DesktopAppIconState | null = null;
let loading = false;
const listeners = new Set<() => void>();

function appIconBridge() {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const get = bridge?.getAppIconState;
  const set = bridge?.setAppIcon;
  return get && set ? { get, set } : null;
}

function publish(next: DesktopAppIconState) {
  current = next;
  for (const listener of listeners) listener();
}

function loadOnce() {
  const bridge = appIconBridge();
  if (!bridge || current || loading) return;
  loading = true;
  void bridge
    .get()
    .then(publish)
    .catch(() => undefined)
    .finally(() => {
      loading = false;
    });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  loadOnce();
  return () => listeners.delete(listener);
}

export function isDesktopAppIconAvailable(): boolean {
  return appIconBridge() !== null;
}

/** The desktop's current icon choice, or null until loaded (or outside the desktop app). */
export function useDesktopAppIconState(): DesktopAppIconState | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}

// Every change goes through one queue so a slower themed update can never land
// after, and undo, a newer choice the user made in Settings.
let queue: Promise<unknown> = Promise.resolve();

export function setDesktopAppIcon(
  input: SetDesktopAppIconInput,
  options: { readonly onlyIf?: (latest: DesktopAppIconState) => boolean } = {},
): Promise<DesktopAppIconState> {
  const bridge = appIconBridge();
  if (!bridge) return Promise.reject(new Error("The app icon can only change in the desktop app."));
  const run = queue.then(async () => {
    if (options.onlyIf && current && !options.onlyIf(current)) return current;
    const next = await bridge.set(input);
    publish(next);
    return next;
  });
  queue = run.catch(() => undefined);
  return run;
}

/** Renders one built-in icon in a scene color to the PNGs the desktop stores. */
export async function renderThemedAppIcon(
  variant: DesktopAppIconVariant,
  color: SidebarImageColorId,
  theme: SidebarImageTheme,
): Promise<DesktopThemedAppIcon> {
  const response = await fetch(themedAppIconUrl(variant, color, theme));
  if (!response.ok) throw new Error("The app icon artwork could not be loaded.");
  const icon = await renderAppIconPngs(await response.blob(), {
    size: THEMED_APP_ICON_SIZE,
    pixelated: true,
  });
  return { key: themedAppIconKey(variant, color, theme), ...icon };
}

let syncingKey: string | null = null;

/**
 * Keeps the Default (or unlocked Dekai) icon colored like the accent color and
 * theme. Mount once; it does nothing outside the desktop app or while a custom
 * icon is in use, and skips work when the stored rendering already matches.
 */
export function useDesktopAppIconSync(): void {
  const { resolvedTheme } = useTheme();
  const accentColor = useSettings((settings) => settings.appAccentColor);
  const state = useDesktopAppIconState();
  const color = resolveSidebarImageColor(accentColor, resolvedTheme);

  useEffect(() => {
    if (!state || state.source !== "default") return;
    const variant = state.variant;
    const key = themedAppIconKey(variant, color, resolvedTheme);
    if (state.themedIconKey === key || syncingKey === key) return;
    syncingKey = key;
    void renderThemedAppIcon(variant, color, resolvedTheme)
      .then((themedIcon) =>
        setDesktopAppIcon(
          { variant, source: "default", themedIcon },
          // Skip if the user switched to a custom icon or toggled Dekai meanwhile.
          { onlyIf: (latest) => latest.source === "default" && latest.variant === variant },
        ),
      )
      .catch(() => undefined)
      .finally(() => {
        if (syncingKey === key) syncingKey = null;
      });
  }, [color, resolvedTheme, state]);
}
