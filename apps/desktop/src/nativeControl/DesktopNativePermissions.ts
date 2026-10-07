import type { NativeControlPermissionsState } from "@cafecode/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Electron from "electron";
import { DesktopEnvironment } from "../app/DesktopEnvironment.ts";
import { ElectronDialog } from "../electron/ElectronDialog.ts";
import { DesktopNativeControl } from "./DesktopNativeControl.ts";
import {
  missingNativePermissions,
  NativePermissionPrompt,
  type NativePermission,
} from "./NativePermissionPrompt.ts";

interface DesktopNativePermissionsShape {
  readonly state: Effect.Effect<NativeControlPermissionsState>;
  readonly prompt: (automatic?: boolean) => Effect.Effect<NativeControlPermissionsState>;
}

export class DesktopNativePermissions extends Context.Service<
  DesktopNativePermissions,
  DesktopNativePermissionsShape
>()("cafecode/desktop/NativePermissions") {}

// Deliberately separate from general openExternal, whose HTTP(S)-only policy
// remains unchanged. Neither the renderer nor a model supplies these URLs.
const SETTINGS_URLS: Record<NativePermission, string> = {
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  "screen-recording":
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
};

export const layer = Layer.effect(
  DesktopNativePermissions,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment;
    const host = yield* DesktopNativeControl;
    const dialog = yield* ElectronDialog;
    const read = (): NativeControlPermissionsState => {
      let accessibility: NativeControlPermissionsState["accessibility"] = "unknown";
      let screenRecording: NativeControlPermissionsState["screenRecording"] = "unknown";
      try {
        accessibility = Electron.systemPreferences.isTrustedAccessibilityClient(false)
          ? "granted"
          : "missing";
      } catch {
        // An unavailable status never proves a grant.
      }
      try {
        screenRecording = Electron.systemPreferences.getMediaAccessStatus("screen");
      } catch {
        // Native health remains available for more detailed diagnostics.
      }
      return { platform: environment.platform, accessibility, screenRecording };
    };
    const prompt = new NativePermissionPrompt({
      platform: environment.platform,
      read,
      enabled: async () => {
        const state = await host.state();
        return state.enabled && state.phase === "ready";
      },
      choose: async (state) => {
        const missing = missingNativePermissions(state);
        const labels: Record<NativePermission, string> = {
          accessibility: "Open Accessibility Settings",
          "screen-recording": "Open Screen Recording Settings",
        };
        const descriptions: Record<NativePermission, string> = {
          accessibility: "Accessibility lets computer use click and type.",
          "screen-recording": "Screen Recording lets computer use see your screen.",
        };
        const result = await Effect.runPromise(
          dialog.showMessageBox({
            type: "info",
            title: "Allow computer use",
            message: "Computer use needs macOS permissions",
            detail: `${missing.map((permission) => descriptions[permission]).join("\n")}\n\nEnable Cafe Code in Privacy & Security. A restart may be required after granting access.`,
            buttons: [...missing.map((permission) => labels[permission]), "Not Now"],
            defaultId: 0,
            cancelId: missing.length,
            noLink: true,
          }),
        );
        return missing[result.response] ?? null;
      },
      request: async (permission) => {
        if (permission === "accessibility") {
          try {
            Electron.systemPreferences.isTrustedAccessibilityClient(true);
          } catch {
            // The explicit settings action still works if macOS cannot show
            // its native first-use prompt for this process.
          }
        } else if (read().screenRecording === "not-determined") {
          // Trigger the native first-use request only after the user chooses
          // it. Tiny thumbnails are discarded here, never returned or saved;
          // no audio, window icons, provider calls or screenshots are attached.
          await Electron.desktopCapturer
            .getSources({
              types: ["screen"],
              thumbnailSize: { width: 1, height: 1 },
              fetchWindowIcons: false,
            })
            .catch(() => undefined);
        }
      },
      openSettings: (permission) => Electron.shell.openExternal(SETTINGS_URLS[permission]),
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => prompt.close()));
    return DesktopNativePermissions.of({
      state: Effect.sync(() => prompt.state()),
      prompt: (automatic) => Effect.promise(() => prompt.prompt(automatic)),
    });
  }),
);
