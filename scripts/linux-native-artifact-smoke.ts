import { spawn } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runNativeDesktopRuntimeSmoke } from "./native-desktop-runtime-smoke.ts";

interface ProcessResult {
  readonly exitCode: number | null;
  readonly stderr: string;
}

function runProcess(command: string, args: readonly string[], cwd: string): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolveProcess, reject) => {
    const child = spawn(command, [...args], { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-20_000);
    });
    child.once("error", reject);
    child.once("exit", (exitCode) => resolveProcess({ exitCode, stderr }));
  });
}

export function selectLinuxAppImage(fileNames: readonly string[]): string {
  const matches = fileNames.filter((fileName) => /^Cafe-Code-.+-x86_64\.AppImage$/u.test(fileName));
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one Linux x64 AppImage, found ${matches.length}.`);
  }
  return matches[0]!;
}

export function isLinuxReleaseMetadataValid(source: string, appImageName: string): boolean {
  const escapedName = appImageName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return (
    new RegExp(`^path:\\s*${escapedName}\\s*$`, "mu").test(source) &&
    new RegExp(`^\\s*- url:\\s*${escapedName}\\s*$`, "mu").test(source) &&
    /^sha512:\s*[A-Za-z0-9+/=]{40,}\s*$/mu.test(source)
  );
}

/** Admit only the ordinary single-link helper in this fixture's extracted
 * directory. No symlink or shared inode may receive privileged preparation. */
export async function resolveLinuxSandboxHelper(extractedRoot: string): Promise<string> {
  const rootInfo = await lstat(extractedRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Linux sandbox preparation requires a real extracted directory.");
  }
  const helper = join(await realpath(extractedRoot), "chrome-sandbox");
  const info = await lstat(helper);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error("Linux sandbox preparation requires a regular unshared helper.");
  }
  return helper;
}

export async function runLinuxNativeArtifactSmoke(releaseDir = resolve("release")): Promise<void> {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("Linux native artifact smoke must run on Linux x64.");
  }
  const releaseFiles = await readdir(releaseDir);
  const appImageName = selectLinuxAppImage(releaseFiles);
  const metadataPath = join(releaseDir, "latest-linux.yml");
  if (!isLinuxReleaseMetadataValid(await readFile(metadataPath, "utf8"), appImageName)) {
    throw new Error("Linux release metadata is missing or does not describe the AppImage.");
  }

  const smokeRoot = await mkdtemp(join(tmpdir(), "cafecode-linux-artifact-smoke-"));
  try {
    const preparedExtractedRoot = process.env.CAFE_CODE_LINUX_EXTRACTED_ROOT?.trim();
    const prepareSandbox = process.env.CAFE_CODE_LINUX_ARTIFACT_PREPARE_SANDBOX === "1";
    if (prepareSandbox && preparedExtractedRoot) {
      throw new Error("Privileged sandbox preparation requires this fixture's own extraction.");
    }
    let extractedRoot: string;
    if (preparedExtractedRoot) {
      extractedRoot = resolve(preparedExtractedRoot);
    } else {
      const extract = await runProcess(
        join(releaseDir, appImageName),
        ["--appimage-extract"],
        smokeRoot,
      );
      if (extract.exitCode !== 0) {
        throw new Error(`AppImage extraction exited nonzero: ${extract.stderr.trim()}`);
      }
      extractedRoot = join(smokeRoot, "squashfs-root");
    }
    if (prepareSandbox) {
      // Native GitHub runners restrict unprivileged namespaces. Configure the
      // exact extracted helper as Chromium requires, preserving the sandbox.
      // This explicit CI-only option never changes a system binary or policy.
      const helper = await resolveLinuxSandboxHelper(extractedRoot);
      const original = await lstat(helper, { bigint: true });
      for (const args of [
        ["chown", "root:root", "--", helper],
        ["chmod", "4755", "--", helper],
      ]) {
        const prepared = await runProcess("sudo", args, smokeRoot);
        if (prepared.exitCode !== 0) {
          throw new Error(`Isolated Linux sandbox preparation failed: ${prepared.stderr.trim()}`);
        }
      }
      const admitted = await resolveLinuxSandboxHelper(extractedRoot);
      const current = await lstat(admitted, { bigint: true });
      if (
        admitted !== helper ||
        current.dev !== original.dev ||
        current.ino !== original.ino ||
        current.uid !== 0n ||
        (current.mode & 0o7777n) !== 0o4755n
      ) {
        throw new Error("Isolated Linux sandbox identity or permissions changed unexpectedly.");
      }
    }
    await runNativeDesktopRuntimeSmoke({
      appPath: join(extractedRoot, "cafe-code"),
      resourcesPath: join(extractedRoot, "resources"),
    });
    console.info("Linux AppImage metadata/runtime/artifact smoke passed.");
  } finally {
    await rm(smokeRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await runLinuxNativeArtifactSmoke(process.argv[2] ? resolve(process.argv[2]) : undefined);
}
