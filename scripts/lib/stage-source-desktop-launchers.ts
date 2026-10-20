// Native checkout/fixture IO retains its existing descriptor, identity and lifetime semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { copyFile, mkdir, writeFile } from "node:fs/promises";
// Host-native path spelling must agree with the existing native file and tool boundary.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { dirname, join } from "node:path";

import {
  macLocalNetworkUsageDescription,
  macMicrophoneUsageDescription,
  renderMacPrivacyStrings,
} from "./mac-app-privacy.ts";

/** Exact source-launcher dependency graph, not a recursive repository copy.
 * Relative imports keep their normal layout under the published dist root. */
const LAUNCHER_FILES = [
  "apps/desktop/scripts/start-electron.mjs",
  "apps/desktop/scripts/start-electron-launchservices.mjs",
  "apps/desktop/scripts/desktop-child-env.mjs",
  "apps/desktop/scripts/electron-launcher.mjs",
  "apps/desktop/scripts/build-mac-dictation-helper.mjs",
  "apps/desktop/scripts/linux-safe-storage.mjs",
  "apps/desktop/scripts/chromium-tls-log-filter.mjs",
  "apps/desktop/src/app/DesktopProfileControl.ts",
  "apps/desktop/native/mac-dictation-target.swift",
  "apps/desktop/native/mac-source-host.m",
  "packages/shared/src/sourceDebugBuild.ts",
  "packages/shared/src/dataProfileStorage.ts",
  "scripts/lib/mac-source-runtime-signing.ts",
  "scripts/lib/mac-source-launch.ts",
  "scripts/lib/mac-source-host.ts",
] as const;

/** Resolve reviewed locale copy while building, not from a missing workspace
 * dependency at runtime. Preserve the existing three locale functions/exports
 * with inert scalar data; no catalog, source text or callback is evaluated by
 * a published launcher beyond this finite lookup. */
export function renderStagedMacPrivacyModule(): string {
  const localized = Object.fromEntries(
    (["en", "ja", "ko"] as const).map((locale) => [
      locale,
      {
        network: macLocalNetworkUsageDescription(locale),
        microphone: macMicrophoneUsageDescription(locale),
        strings: renderMacPrivacyStrings(locale),
      },
    ]),
  );
  return (
    `const localized = ${JSON.stringify(localized)};\n` +
    `const selected = (locale) => Object.prototype.hasOwnProperty.call(localized, locale) ? localized[locale] : localized.en;\n` +
    `export function macLocalNetworkUsageDescription(locale = "en") { return selected(locale).network; }\n` +
    `export function macMicrophoneUsageDescription(locale = "en") { return selected(locale).microphone; }\n` +
    `export function renderMacPrivacyStrings(locale) { return selected(locale).strings; }\n` +
    `export const MAC_LOCAL_NETWORK_USAGE_DESCRIPTION = macLocalNetworkUsageDescription();\n` +
    `export const MAC_MICROPHONE_USAGE_DESCRIPTION = macMicrophoneUsageDescription();\n`
  );
}

export async function stageSourceDesktopLauncherFiles(
  repositoryRoot: string,
  runtimeRoot: string,
): Promise<void> {
  for (const relative of LAUNCHER_FILES) {
    const source = join(repositoryRoot, ...relative.split("/"));
    const destination = join(runtimeRoot, ...relative.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
  const privacy = join(runtimeRoot, "scripts", "lib", "mac-app-privacy.ts");
  await mkdir(dirname(privacy), { recursive: true });
  await writeFile(privacy, renderStagedMacPrivacyModule(), { mode: 0o600 });
}
