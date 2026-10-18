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
 * Windows `wco` class. Ordinary headers keep using `useMacDesktopTitlebar`.
 */
export const MAC_TRAFFIC_LIGHTS_CLASS_NAME = "mac-traffic-lights";

/**
 * Call only for an ordinary Electron app window. The frameless global
 * dictation panel has no traffic lights and must not reserve their band.
 */
export function syncDocumentMacTrafficLightsClass(): void {
  if (typeof document === "undefined" || typeof navigator === "undefined") {
    return;
  }
  document.documentElement.classList.toggle(
    MAC_TRAFFIC_LIGHTS_CLASS_NAME,
    isMacPlatform(navigator.platform),
  );
}
