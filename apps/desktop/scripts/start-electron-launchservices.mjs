import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { macSourceLaunchArgs } from "../../../scripts/lib/mac-source-launch.ts";
import { desktopDir, resolveElectronPath } from "./electron-launcher.mjs";
import { ensureMacDictationHelper } from "./build-mac-dictation-helper.mjs";
import { buildDesktopChildEnv } from "./start-electron.mjs";

if (process.platform !== "darwin") {
  throw new Error("The LaunchServices source launcher is macOS-only.");
}

const executable = resolveElectronPath();
ensureMacDictationHelper();
const baseDir = resolve(process.env.CAFE_CODE_HOME?.trim() || join(homedir(), ".cafe-code"));
const logDir = join(baseDir, "restart-logs");
mkdirSync(logDir, { recursive: true, mode: 0o700 });
const logName = `source-launch-${new Date().toISOString().replace(/[:.]/gu, "-")}-${process.pid}`;
const stdoutPath = join(logDir, `${logName}.stdout.log`);
const stderrPath = join(logDir, `${logName}.stderr.log`);
for (const path of [stdoutPath, stderrPath]) closeSync(openSync(path, "wx", 0o600));

const args = macSourceLaunchArgs({
  appBundlePath: resolve(dirname(executable), "../.."),
  entryPath: join(desktopDir, "dist-electron", "main.cjs"),
  stdoutPath,
  stderrPath,
  args: process.argv.slice(2),
});
const result = spawnSync("/usr/bin/open", args, {
  env: buildDesktopChildEnv(process.env),
  encoding: "utf8",
  shell: false,
});
if (result.error || result.status !== 0) {
  throw new Error(result.error?.message || result.stderr.trim() || "macOS app launch failed.");
}
console.log(`Cafe Code launched through LaunchServices. Logs: ${stdoutPath}, ${stderrPath}`);
