import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  macSourceLaunchArgs,
  resolveMacSourceConfiguredHome,
} from "../../../scripts/lib/mac-source-launch.ts";
import { desktopDir, resolveElectronPath } from "./electron-launcher.mjs";
import { ensureMacDictationHelper } from "./build-mac-dictation-helper.mjs";
import { buildDesktopChildEnv } from "./desktop-child-env.mjs";
import { prepareDebugDataProfile } from "../../../packages/shared/src/dataProfileStorage.ts";
import { assertSourceDebugDesktopBuilds } from "../../../packages/shared/src/sourceDebugBuild.ts";
import { prepareMacSourceHost } from "../../../scripts/lib/mac-source-host.ts";

export async function runStartElectronLaunchServices({
  args: appArgs = process.argv.slice(2),
  environment = process.env,
} = {}) {
  if (process.platform !== "darwin") {
    throw new Error("The LaunchServices source launcher is macOS-only.");
  }
  const baseDir = resolveMacSourceConfiguredHome(environment.CAFE_CODE_HOME, homedir());
  assertSourceDebugDesktopBuilds(desktopDir);
  // Logs are profile-owned IO too. Admit the fixed private namespace before
  // mkdir/open can follow a preexisting Debug alias into Production; failure
  // leaves the selected app and every other profile unstarted and untouched.
  await prepareDebugDataProfile(baseDir);
  const executable = resolveElectronPath();
  const hostBundle = prepareMacSourceHost({ homeDirectory: homedir() });
  ensureMacDictationHelper();
  const logDir = join(baseDir, ".debug", "restart-logs");
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const logName = `source-launch-${new Date().toISOString().replace(/[:.]/gu, "-")}-${process.pid}`;
  const stdoutPath = join(logDir, `${logName}.stdout.log`);
  const stderrPath = join(logDir, `${logName}.stderr.log`);
  for (const path of [stdoutPath, stderrPath]) closeSync(openSync(path, "wx", 0o600));

  const args = macSourceLaunchArgs({
    appBundlePath: hostBundle,
    runtimeBundlePath: resolve(dirname(executable), "../.."),
    entryPath: join(desktopDir, "dist-electron", "main.cjs"),
    stdoutPath,
    stderrPath,
    configuredBaseDir: baseDir,
    args: appArgs,
  });
  const result = spawnSync("/usr/bin/open", args, {
    env: buildDesktopChildEnv(environment),
    encoding: "utf8",
    shell: false,
  });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr.trim() || "macOS app launch failed.");
  }
  console.log(`Cafe Code launched through LaunchServices. Logs: ${stdoutPath}, ${stderrPath}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runStartElectronLaunchServices();
}
