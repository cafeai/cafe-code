#!/usr/bin/env node

import { closeSync, constants, existsSync, fchmodSync, fstatSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// Resolve native packages from the runtime workspace that owns this
// postinstall. Yarn builds that workspace only after its native dependencies,
// avoiding a race with node-pty's source build on platforms without prebuilds.
const desktopRuntimeRequire = createRequire(
  new URL("../packaging/desktop-runtime/package.json", import.meta.url),
);
const EXECUTABLE_PERMISSION_BITS = 0o111;

export function ensureNodePtySpawnHelperExecutable(
  nodePtyPackageRoot: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  // node-pty's binding.gyp builds spawn-helper only for macOS, and its native
  // fork implementation consumes the helper only inside the __APPLE__ branch.
  // Linux uses forkpty directly, so requiring a helper there rejects a valid
  // source build after node-gyp has successfully produced pty.node.
  if (platform !== "darwin") {
    return null;
  }

  // node-pty searches build outputs before its packaged prebuild. Match that
  // order so a source-built addon and its helper cannot drift apart.
  const nativeDirectories = [
    join(nodePtyPackageRoot, "build", "Release"),
    join(nodePtyPackageRoot, "build", "Debug"),
    join(nodePtyPackageRoot, "prebuilds", `${platform}-${arch}`),
  ];
  const nativeDirectory = nativeDirectories.find((directory) =>
    existsSync(join(directory, "pty.node")),
  );
  if (!nativeDirectory) {
    throw new Error(`node-pty has no native runtime for ${platform}-${arch}.`);
  }

  const helperPath = join(nativeDirectory, "spawn-helper");
  let descriptor: number;
  try {
    // Yarn's node-modules linker currently extracts node-pty's macOS helper
    // without executable bits. Open the helper without following symlinks,
    // then chmod the already-open file descriptor. This avoids turning a
    // compromised node_modules symlink into an arbitrary chmod target.
    descriptor = openSync(helperPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error("node-pty spawn-helper is missing or is not a safe regular file.", {
      cause: error,
    });
  }

  try {
    const initialStat = fstatSync(descriptor);
    if (!initialStat.isFile()) {
      throw new Error("node-pty spawn-helper is not a regular file.");
    }

    const initialMode = initialStat.mode & 0o777;
    if ((initialMode & EXECUTABLE_PERMISSION_BITS) !== EXECUTABLE_PERMISSION_BITS) {
      fchmodSync(descriptor, initialMode | EXECUTABLE_PERMISSION_BITS);
    }

    const finalMode = fstatSync(descriptor).mode & 0o777;
    if ((finalMode & EXECUTABLE_PERMISSION_BITS) !== EXECUTABLE_PERMISSION_BITS) {
      throw new Error("node-pty spawn-helper executable permissions could not be restored.");
    }
  } finally {
    closeSync(descriptor);
  }

  return helperPath;
}

export function ensureInstalledDesktopRuntime(): void {
  const electronExecutable = desktopRuntimeRequire("electron") as unknown;
  if (typeof electronExecutable !== "string" || !existsSync(electronExecutable)) {
    throw new Error("The pinned Electron executable is unavailable after installation.");
  }

  if (process.platform === "darwin") {
    const nodePtyPackageRoot = dirname(desktopRuntimeRequire.resolve("node-pty/package.json"));
    ensureNodePtySpawnHelperExecutable(nodePtyPackageRoot);
  }
}

if (import.meta.main) {
  ensureInstalledDesktopRuntime();
}
