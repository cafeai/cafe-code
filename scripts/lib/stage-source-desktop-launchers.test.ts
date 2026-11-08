// This boundary retains exact native child handles and close/signal ownership.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
// Native checkout/fixture IO retains its existing descriptor, identity and lifetime semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { appendFile, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
import { DESKTOP_RESTART_EXISTING_FLAG } from "../../apps/desktop/src/app/DesktopProfileControl.ts";

const temporary: string[] = [];
const owners: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of owners.splice(0)) await close();
  for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true });
});

async function stageLaunchFixture() {
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
      "apps/desktop/scripts/build-mac-keep-awake-helper.mjs",
      "export function ensureMacKeepAwakeHelper() {}",
    ],
    [
      "apps/desktop/scripts/build-mac-provider-daemon-control-helper.mjs",
      "export function ensureMacProviderDaemonControlHelper() {}",
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
       import { appendFileSync, writeFileSync } from "node:fs";
       import { syncBuiltinESMExports } from "node:module";
       Object.defineProperty(process, "platform", { value: "darwin" });
       childProcess.spawnSync = (command, args, options) => {
         if (command !== "/usr/bin/open") throw new Error("Unexpected native launch");
         writeFileSync(process.env.CAFE_LAUNCH_RECEIPT,
           JSON.stringify({ command, args, env: options.env }), { flag: "wx" });
         appendFileSync(args[args.indexOf("--stdout") + 1], "fixture initial stdout\\n");
         appendFileSync(args[args.indexOf("--stderr") + 1], "fixture initial stderr\\n");
         return { status: 0, stderr: "" };
       };
       process.kill = () => { throw new Error("The observer must not signal an app process"); };
       syncBuiltinESMExports();`,
  );
  const configuredHome = join(runtimeRoot, "private-home");
  return { runtimeRoot, desktop, runtimeBundle, hostBundle, receipt, preload, configuredHome };
}

describe("published source desktop launcher dependencies", () => {
  it.each(["--no-follow", DESKTOP_RESTART_EXISTING_FLAG])(
    "returns after the macOS LaunchServices %s launch without an import deadlock",
    async (launchFlag) => {
      const { desktop, runtimeBundle, hostBundle, receipt, preload, configuredHome } =
        await stageLaunchFixture();
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          pathToFileURL(preload).href,
          join(desktop, "scripts", "start-electron.mjs"),
          "--cafe-debug",
          launchFlag,
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
      const forwardedArgs =
        launchFlag === "--no-follow" ? ["--cafe-debug"] : ["--cafe-debug", launchFlag];
      expect(launched.args.slice(-(5 + forwardedArgs.length))).toEqual([
        "--args",
        "--cafe-source-runtime",
        runtimeBundle,
        "--cafe-source-entry",
        join(desktop, "dist-electron", "main.cjs"),
        ...forwardedArgs,
      ]);
      expect(launched.args).toContain(`CAFE_CODE_HOME=${configuredHome}`);
      expect(launched.env.CAFE_CODE_DATA_PROFILE).toBe("debug");
      expect(launched.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
      expect(launched.args).not.toContain("--no-follow");
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps the default console launch following both logs until SIGINT retires only the observer",
    async (context) => {
      let child: ChildProcess | undefined;
      let closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
      let didClose = false;
      let retired = false;
      let preparation: ReturnType<typeof stageLaunchFixture> | undefined;
      let cleanup: Promise<void> | undefined;
      const close = () =>
        (cleanup ??= (async () => {
          retired = true;
          await preparation?.catch(() => {});
          if (child && !didClose) child.kill("SIGTERM");
          await closed;
        })());
      context.signal.addEventListener(
        "abort",
        () => {
          void close();
        },
        { once: true },
      );
      context.onTestFinished(close);
      owners.push(close);
      preparation = stageLaunchFixture();
      const { desktop, receipt, preload, configuredHome } = await preparation;
      if (retired) return;
      child = spawn(
        process.execPath,
        ["--import", pathToFileURL(preload).href, join(desktop, "scripts", "start-electron.mjs")],
        {
          env: { CAFE_CODE_HOME: configuredHome, CAFE_LAUNCH_RECEIPT: receipt },
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
        },
      );
      const exactChild = child;
      closed = new Promise((resolve, reject) => {
        exactChild.once("error", reject);
        exactChild.once("close", (code, signal) => {
          didClose = true;
          resolve({ code, signal });
        });
      });
      const exitedBeforeOutput = closed.then(() => {
        throw new Error("The synthetic launcher exited before the expected log output.");
      });
      let stdout = "";
      let stderr = "";
      const waiters: Array<{ marker: string; stream: "stdout" | "stderr"; resolve: () => void }> =
        [];
      const waitFor = (stream: "stdout" | "stderr", marker: string) =>
        new Promise<void>((resolve) => {
          waiters.push({ stream, marker, resolve });
        });
      const initial = Promise.all([
        waitFor("stdout", "fixture initial stdout"),
        waitFor("stderr", "fixture initial stderr"),
      ]);
      const appended = Promise.all([
        waitFor("stdout", "fixture later stdout"),
        waitFor("stderr", "fixture later stderr"),
      ]);
      const observe = () => {
        for (const waiter of waiters)
          if ((waiter.stream === "stdout" ? stdout : stderr).includes(waiter.marker))
            waiter.resolve();
      };
      exactChild.stdout!.on("data", (chunk: Buffer) => {
        stdout = (stdout + chunk.toString()).slice(-32_768);
        observe();
      });
      exactChild.stderr!.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-32_768);
        observe();
      });
      await Promise.race([initial, exitedBeforeOutput]);
      expect(exactChild.exitCode).toBeNull();
      const launched = JSON.parse(await readFile(receipt, "utf8"));
      await appendFile(
        launched.args[launched.args.indexOf("--stdout") + 1],
        "fixture later stdout\n",
      );
      await appendFile(
        launched.args[launched.args.indexOf("--stderr") + 1],
        "fixture later stderr\n",
      );
      await Promise.race([appended, exitedBeforeOutput]);
      exactChild.kill("SIGINT");
      expect(await closed).toEqual({ code: 130, signal: null });
      expect(stdout).toContain("Cafe Code will keep running.");
      expect(stdout).not.toContain("fixture initial stderr");
      expect(stderr).not.toContain("fixture later stdout");
    },
  );

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
