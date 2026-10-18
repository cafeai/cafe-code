import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { stageSourceDesktopLauncherFiles } from "./stage-source-desktop-launchers.ts";
import {
  macLocalNetworkUsageDescription,
  macMicrophoneUsageDescription,
  renderMacPrivacyStrings,
} from "./mac-app-privacy.ts";

const temporary: string[] = [];
afterEach(async () => {
  for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("published source desktop launcher dependencies", () => {
  it("imports the isolated staged graph without workspace dependencies or launching an app", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "cafe-staged-launcher-"));
    temporary.push(runtimeRoot);
    const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    await stageSourceDesktopLauncherFiles(repository, runtimeRoot);
    const launcher = await import(
      pathToFileURL(join(runtimeRoot, "apps", "desktop", "scripts", "start-electron.mjs")).href
    );
    expect(
      launcher.buildDesktopChildEnv({ CAFE_CODE_DATA_PROFILE: "production" })
        .CAFE_CODE_DATA_PROFILE,
    ).toBe("debug");
    expect(() => launcher.resolveHeadlessServerArgs(["--data-profile", "production"])).toThrow(
      "Source launches require the Debug data profile",
    );
    const launchServices = await import(
      pathToFileURL(
        join(runtimeRoot, "apps", "desktop", "scripts", "start-electron-launchservices.mjs"),
      ).href
    );
    expect(typeof launchServices.runStartElectronLaunchServices).toBe("function");
    const privacy = await import(
      pathToFileURL(join(runtimeRoot, "scripts", "lib", "mac-app-privacy.ts")).href
    );
    for (const locale of ["en", "ja", "ko"] as const) {
      expect(privacy.macLocalNetworkUsageDescription(locale)).toBe(
        macLocalNetworkUsageDescription(locale),
      );
      expect(privacy.macMicrophoneUsageDescription(locale)).toBe(
        macMicrophoneUsageDescription(locale),
      );
      expect(privacy.renderMacPrivacyStrings(locale)).toBe(renderMacPrivacyStrings(locale));
    }
  });
});
