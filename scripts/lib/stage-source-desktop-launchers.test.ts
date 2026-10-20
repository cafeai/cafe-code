// This boundary retains exact native child handles and close/signal ownership.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { spawnSync } from "node:child_process";
// Native checkout/fixture IO retains its existing descriptor, identity and lifetime semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// Host-native path spelling must agree with the existing native file and tool boundary.
// @effect-diagnostics-next-line nodeBuiltinImport:off
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
  it("executes the normal macOS entrypoint through LaunchServices without an import deadlock", async () => {
    // Node canonicalizes the executable module URL (including macOS /tmp), so
    // argv must use that same native path for the real main-entry guard.
    const runtimeRoot = await realpath(await mkdtemp(join(tmpdir(), "cafe-launch-entrypoint-")));
    temporary.push(runtimeRoot);
    const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    await stageSourceDesktopLauncherFiles(repository, runtimeRoot);
    const desktop = join(runtimeRoot, "apps", "desktop");
    const runtimeBundle = join(runtimeRoot, "Debug Runtime.app");
    const hostBundle = join(runtimeRoot, "Debug Host.app");
    // Keep both executable launchers and their real shared imports. Only the
    // native/build admission leaves are inert, so this checks Node's actual
    // entrypoint evaluation without an app, provider, compiler or live profile.
    const leaves = [
      [
        "apps/desktop/scripts/electron-launcher.mjs",
        `export const desktopDir = ${JSON.stringify(desktop)};
         export const resolveElectronPath = () => ${JSON.stringify(join(runtimeBundle, "Contents", "MacOS", "Electron"))};`,
      ],
      [
        "apps/desktop/scripts/build-mac-dictation-helper.mjs",
        "export function ensureMacDictationHelper() {}",
      ],
      [
        "packages/shared/src/sourceDebugBuild.ts",
        "export function assertSourceDebugDesktopBuilds() {}",
      ],
      [
        "packages/shared/src/dataProfileStorage.ts",
        "export async function prepareDebugDataProfile() {}",
      ],
      [
        "scripts/lib/mac-source-host.ts",
        `export const prepareMacSourceHost = () => ${JSON.stringify(hostBundle)};`,
      ],
    ];
    for (const [relative, source] of leaves) {
      await writeFile(join(runtimeRoot, relative!), source!);
    }
    const receipt = join(runtimeRoot, "launch.json");
    const preload = join(runtimeRoot, "native-launch-fixture.mjs");
    await writeFile(
      preload,
      `import childProcess from "node:child_process";
       import { writeFileSync } from "node:fs";
       import { syncBuiltinESMExports } from "node:module";
       Object.defineProperty(process, "platform", { value: "darwin" });
       childProcess.spawnSync = (command, args, options) => {
         if (command !== "/usr/bin/open") throw new Error("Unexpected native launch");
         writeFileSync(process.env.CAFE_LAUNCH_RECEIPT,
           JSON.stringify({ command, args, env: options.env }), { flag: "wx" });
         return { status: 0, stderr: "" };
       };
       syncBuiltinESMExports();`,
    );
    const configuredHome = join(runtimeRoot, "private-home");
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(preload).href,
        join(desktop, "scripts", "start-electron.mjs"),
        "--cafe-debug",
      ],
      {
        env: {
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
          CAFE_CODE_HOME: configuredHome,
          CAFE_LAUNCH_RECEIPT: receipt,
          ELECTRON_RUN_AS_NODE: "1",
        },
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 32 * 1024,
        shell: false,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const launched = JSON.parse(await readFile(receipt, "utf8"));
    expect(launched.command).toBe("/usr/bin/open");
    expect(launched.args.slice(0, 3)).toEqual(["-n", "-a", hostBundle]);
    expect(launched.args.slice(-6)).toEqual([
      "--args",
      "--cafe-source-runtime",
      runtimeBundle,
      "--cafe-source-entry",
      join(desktop, "dist-electron", "main.cjs"),
      "--cafe-debug",
    ]);
    expect(launched.args).toContain(`CAFE_CODE_HOME=${configuredHome}`);
    expect(launched.env.CAFE_CODE_DATA_PROFILE).toBe("debug");
    expect(launched.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

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
