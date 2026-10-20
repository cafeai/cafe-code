// Native path boundary: preserve host drive, namespace and separator semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";

import type { DesktopEnvironmentShape } from "../app/DesktopEnvironment.ts";

type MacDictationTargetEnvironment = Pick<
  DesktopEnvironmentShape,
  "platform" | "processArch" | "isPackaged" | "resourcesPath" | "appRoot"
>;

/**
 * The privileged AX helper is always selected by desktop-main from Cafe's
 * own build output. No renderer, setting, provider, or user-supplied path can
 * choose another executable. The source and release paths intentionally differ
 * because Electron packages the native binary outside app.asar.
 */
export function resolveMacDictationTargetPath(
  environment: MacDictationTargetEnvironment,
): string | null {
  if (environment.platform !== "darwin") return null;
  return environment.isPackaged
    ? join(environment.resourcesPath, "mac-dictation-target")
    : join(
        environment.appRoot,
        "apps",
        "desktop",
        "native",
        "build",
        environment.processArch,
        "mac-dictation-target",
      );
}
