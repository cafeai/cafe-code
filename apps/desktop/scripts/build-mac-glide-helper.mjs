#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const desktopDirectory = resolve(dirname(scriptPath), "..");
const sourcePath = join(desktopDirectory, "native", "mac-glide.swift");
const focusPolicyPath = join(desktopDirectory, "native", "mac-glide-focus-policy.swift");
const routingPath = join(desktopDirectory, "native", "mac-glide-routing.swift");
const menuGuardPath = join(desktopDirectory, "native", "mac-glide-menu-guard.swift");
const keyRescuePath = join(desktopDirectory, "native", "mac-glide-key-rescue-policy.swift");
const keyRescueGuardPath = join(desktopDirectory, "native", "mac-glide-key-rescue-guard.swift");
const incomingFocusPath = join(desktopDirectory, "native", "mac-glide-incoming-focus.swift");
const actionPolicyPath = join(desktopDirectory, "native", "mac-glide-action-policy.swift");

export function sourceMacGlideHelperPath(architecture = process.arch) {
  return join(desktopDirectory, "native", "build", architecture, "mac-glide");
}

/** Build only the fixed repository source. Atomic sibling publication keeps a
 * failed/interrupted compiler from replacing the last usable helper. This is a
 * source-development artifact; release signing/registration is separate. */
export function ensureMacGlideHelper({
  architecture = process.arch,
  outputPath = sourceMacGlideHelperPath(architecture),
  platform = process.platform,
  force = false,
} = {}) {
  if (platform !== "darwin") return null;
  if (!["arm64", "x64", "universal"].includes(architecture) || !isAbsolute(outputPath))
    throw new Error("Unsupported Glide helper build target.");
  if (!force && architecture !== "universal") {
    try {
      const metadata = lstatSync(outputPath);
      if (
        metadata.isFile() &&
        !metadata.isSymbolicLink() &&
        metadata.mode & 0o111 &&
        metadata.mtimeMs >=
          Math.max(
            statSync(sourcePath).mtimeMs,
            statSync(focusPolicyPath).mtimeMs,
            statSync(routingPath).mtimeMs,
            statSync(menuGuardPath).mtimeMs,
            statSync(keyRescuePath).mtimeMs,
            statSync(keyRescueGuardPath).mtimeMs,
            statSync(incomingFocusPath).mtimeMs,
            statSync(actionPolicyPath).mtimeMs,
            statSync(scriptPath).mtimeMs,
          )
      )
        return outputPath;
    } catch {
      /* Missing or inadmissible output requires a fresh build. */
    }
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  const temporary = mkdtempSync(join(tmpdir(), "cafe-glide-helper-"));
  const run = (tool, args) => {
    const result = spawnSync("xcrun", [tool, ...args], {
      cwd: desktopDirectory,
      stdio: "inherit",
      shell: false,
      timeout: 5 * 60_000,
    });
    if (result.error || result.status !== 0) throw new Error("Native Glide helper build failed.");
  };
  const compile = (architecture, destination) =>
    run("swiftc", [
      "-O",
      "-parse-as-library",
      "-target",
      `${architecture === "x64" ? "x86_64" : "arm64"}-apple-macosx14.0`,
      sourcePath,
      focusPolicyPath,
      routingPath,
      menuGuardPath,
      keyRescuePath,
      keyRescueGuardPath,
      incomingFocusPath,
      actionPolicyPath,
      "-o",
      destination,
    ]);
  try {
    const executable = join(temporary, "mac-glide");
    if (architecture === "universal") {
      compile("arm64", join(temporary, "arm64"));
      compile("x64", join(temporary, "x64"));
      run("lipo", [
        "-create",
        "-output",
        executable,
        join(temporary, "arm64"),
        join(temporary, "x64"),
      ]);
    } else compile(architecture, executable);
    const sibling = mkdtempSync(join(dirname(outputPath), ".glide-helper-"));
    try {
      const staged = join(sibling, "mac-glide");
      copyFileSync(executable, staged);
      chmodSync(staged, 0o755);
      renameSync(staged, outputPath);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
    return outputPath;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const { values } = parseArgs({
    options: { arch: { type: "string" }, output: { type: "string" }, force: { type: "boolean" } },
  });
  const architecture = values.arch ?? process.arch;
  ensureMacGlideHelper({
    architecture,
    outputPath: values.output ? resolve(values.output) : sourceMacGlideHelperPath(architecture),
    force: values.force ?? false,
  });
}
