import { isMacPlatform } from "./utils";

/**
 * macOS draws the window's traffic lights above all renderer content at a fixed
 * native position (`trafficLightPosition` in
 * apps/desktop/src/window/DesktopWindow.ts), inside the shared
 * `--app-mac-titlebar-height` band. That band does not move with Cafe's
 * rem-based interface scale or the viewport size.
 *
 * Full-window and near-fullscreen surfaces keep their controls out of it with
 * the `mac-traffic-lights:` CSS variant keyed on this root class, mirroring the
 * Windows `wco` class. Ordinary headers keep using `useMacDesktopTitlebar`
 * for their fixed height and trailing sidebar toggle. Native fullscreen hides
 * the lights, so its separate root class releases only their leading space.
 */
export const MAC_TRAFFIC_LIGHTS_CLASS_NAME = "mac-traffic-lights";
const MAC_FULL_SCREEN_CLASS_NAME = "mac-fullscreen";

/**
 * Call only for an ordinary Electron app window. The frameless global
 * dictation panel has no traffic lights and must not reserve their band.
 */
export function syncDocumentMacTrafficLightsClass(): () => void {
  if (
    typeof window === "undefined" ||
    typeof document === "undefined" ||
    typeof navigator === "undefined"
  ) {
    return () => {};
  }
  const root = document.documentElement;
  const isMac = isMacPlatform(navigator.platform);
  let retired = false;
  const update = (fullScreen: boolean) => {
    if (retired) return;
    root.classList.toggle(MAC_TRAFFIC_LIGHTS_CLASS_NAME, isMac && !fullScreen);
    root.classList.toggle(MAC_FULL_SCREEN_CLASS_NAME, isMac && fullScreen);
  };
  // Read native state for both initial load and renderer reloads. Subscribe
  // first and keep initialization synchronous so no awaited snapshot can
  // overwrite a later transition. Older desktop bridges retain safe clearance.
  const unsubscribe = isMac ? window.desktopBridge?.onWindowFullScreenChanged?.(update) : undefined;
  update(isMac && window.desktopBridge?.getWindowFullScreen?.() === true);
  return () => {
    retired = true;
    unsubscribe?.();
    root.classList.remove(MAC_TRAFFIC_LIGHTS_CLASS_NAME, MAC_FULL_SCREEN_CLASS_NAME);
  };
}
