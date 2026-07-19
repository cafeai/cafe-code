import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runNativeDesktopRuntimeSmoke } from "./native-desktop-runtime-smoke.ts";

interface ProcessResult {
  readonly exitCode: number | null;
}

async function runProcess(
  command: string,
  args: readonly string[],
  timeoutMs = 10 * 60_000,
): Promise<ProcessResult> {
  return await new Promise<ProcessResult>((resolveProcess, reject) => {
    const child = spawn(command, [...args], {
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("exit", (exitCode) => {
      clearTimeout(timeout);
      resolveProcess({ exitCode });
    });
  });
}

function assertSuccessful(result: ProcessResult, operation: string): void {
  if (result.exitCode !== 0) throw new Error(`${operation} exited nonzero.`);
}

export function selectMacArtifacts(
  fileNames: readonly string[],
  arch: "arm64" | "x64",
): { readonly dmg: string; readonly zip: string } {
  const dmgMatches = fileNames.filter((fileName) =>
    new RegExp(`^Cafe-Code-.+-${arch}\\.dmg$`).test(fileName),
  );
  const zipMatches = fileNames.filter((fileName) =>
    new RegExp(`^Cafe-Code-.+-${arch}\\.zip$`).test(fileName),
  );
  if (dmgMatches.length !== 1 || zipMatches.length !== 1) {
    throw new Error(
      `Expected one ${arch} DMG and ZIP artifact; found ${dmgMatches.length} DMG and ${zipMatches.length} ZIP.`,
    );
  }
  return { dmg: dmgMatches[0]!, zip: zipMatches[0]! };
}

async function findAppBundle(directory: string): Promise<string> {
  const matches = (await readdir(directory)).filter((fileName) => fileName.endsWith(".app"));
  if (matches.length !== 1) throw new Error(`Expected one app bundle, found ${matches.length}.`);
  return join(directory, matches[0]!);
}

async function findAppExecutable(appBundle: string): Promise<string> {
  const executableDir = join(appBundle, "Contents", "MacOS");
  const matches = await readdir(executableDir);
  if (matches.length !== 1)
    throw new Error(`Expected one app executable, found ${matches.length}.`);
  return join(executableDir, matches[0]!);
}

export async function runMacosNativeArtifactSmoke(releaseDir = resolve("release")): Promise<void> {
  if (process.platform !== "darwin" || (process.arch !== "arm64" && process.arch !== "x64")) {
    throw new Error("macOS native artifact smoke must run on a supported macOS architecture.");
  }
  const arch = process.arch;
  const artifacts = selectMacArtifacts(await readdir(releaseDir), arch);
  const smokeRoot = await mkdtemp(join(tmpdir(), "cafecode-macos-artifact-smoke-"));
  const mountPoint = join(smokeRoot, "mount");
  const installedApp = join(smokeRoot, "installed", "Cafe Code.app");
  const zipRoot = join(smokeRoot, "zip");
  await Promise.all([
    mkdir(mountPoint, { recursive: true }),
    mkdir(join(smokeRoot, "installed"), { recursive: true }),
    mkdir(zipRoot, { recursive: true }),
  ]);
  let mounted = false;

  try {
    assertSuccessful(
      await runProcess("hdiutil", [
        "attach",
        join(releaseDir, artifacts.dmg),
        "-nobrowse",
        "-readonly",
        "-mountpoint",
        mountPoint,
      ]),
      "DMG mount",
    );
    mounted = true;
    const mountedApp = await findAppBundle(mountPoint);
    assertSuccessful(await runProcess("ditto", [mountedApp, installedApp]), "DMG app copy");
    const appPath = await findAppExecutable(installedApp);
    if (!existsSync(join(installedApp, "Contents", "Resources", "app-update.yml"))) {
      throw new Error("Packaged macOS updater metadata is missing.");
    }
    await runNativeDesktopRuntimeSmoke({ appPath });

    assertSuccessful(
      await runProcess("ditto", ["-x", "-k", join(releaseDir, artifacts.zip), zipRoot]),
      "ZIP extraction",
    );
    const zipApp = await findAppBundle(zipRoot);
    if (!existsSync(join(zipApp, "Contents", "Resources", "app-update.yml"))) {
      throw new Error("Packaged macOS ZIP updater metadata is missing.");
    }
    await runNativeDesktopRuntimeSmoke({ appPath: await findAppExecutable(zipApp) });
    console.info("macOS DMG and ZIP runtime/updater/artifact smoke passed.");
  } finally {
    if (mounted) {
      await runProcess("hdiutil", ["detach", mountPoint, "-force"], 60_000).catch(() => undefined);
    }
    await rm(smokeRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await runMacosNativeArtifactSmoke(process.argv[2] ? resolve(process.argv[2]) : undefined);
}
