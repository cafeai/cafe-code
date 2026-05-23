import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const desktopDir = resolve(__dirname, "..");

const macAppName = "Cafe Code";
const macBundleIdentifier = "com.cafeai.cafecode";
const macRuntimeLauncherVersion = 1;
const macRuntimeDir = join(desktopDir, ".electron-runtime");
const macRuntimeMetadataPath = join(macRuntimeDir, "metadata.json");
const macRuntimeAppBundlePath = join(macRuntimeDir, `${macAppName}.app`);
const macRuntimeExecutablePath = join(macRuntimeAppBundlePath, "Contents", "MacOS", "Electron");
const macRuntimeIconPath = join(desktopDir, "resources", "icon.icns");

function resolveInstalledElectronPath() {
  const require = createRequire(import.meta.url);
  return require("electron");
}

function resolveMacSourceAppBundlePath(electronExecutablePath) {
  return resolve(dirname(electronExecutablePath), "../..");
}

function statFingerprint(path) {
  const stat = statSync(path);
  return `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function replacePlistString(plistPath, key, value) {
  const result = spawnSync("plutil", ["-replace", key, "-string", value, plistPath], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || "unknown plutil failure").trim();
    throw new Error(`Failed to patch ${key} in ${plistPath}: ${message}`);
  }
}

function patchMacAppBundlePlists(appBundlePath) {
  const appInfoPlistPath = join(appBundlePath, "Contents", "Info.plist");
  replacePlistString(appInfoPlistPath, "CFBundleDisplayName", macAppName);
  replacePlistString(appInfoPlistPath, "CFBundleName", macAppName);
  replacePlistString(appInfoPlistPath, "CFBundleIdentifier", macBundleIdentifier);
  replacePlistString(appInfoPlistPath, "CFBundleIconFile", "icon.icns");

  const frameworkPath = join(appBundlePath, "Contents", "Frameworks");
  const helperPlists = [
    {
      path: join(frameworkPath, "Electron Helper.app", "Contents", "Info.plist"),
      name: `${macAppName} Helper`,
      identifier: `${macBundleIdentifier}.helper`,
    },
    {
      path: join(frameworkPath, "Electron Helper (Renderer).app", "Contents", "Info.plist"),
      name: `${macAppName} Helper (Renderer)`,
      identifier: `${macBundleIdentifier}.helper.renderer`,
    },
    {
      path: join(frameworkPath, "Electron Helper (GPU).app", "Contents", "Info.plist"),
      name: `${macAppName} Helper (GPU)`,
      identifier: `${macBundleIdentifier}.helper.gpu`,
    },
    {
      path: join(frameworkPath, "Electron Helper (Plugin).app", "Contents", "Info.plist"),
      name: `${macAppName} Helper (Plugin)`,
      identifier: `${macBundleIdentifier}.helper.plugin`,
    },
  ];

  for (const helper of helperPlists) {
    if (!existsSync(helper.path)) {
      continue;
    }
    replacePlistString(helper.path, "CFBundleName", helper.name);
    replacePlistString(helper.path, "CFBundleIdentifier", helper.identifier);
  }
}

function resolveBrandedMacElectronPath(electronExecutablePath) {
  const sourceAppBundlePath = resolveMacSourceAppBundlePath(electronExecutablePath);
  const expectedMetadata = {
    launcherVersion: macRuntimeLauncherVersion,
    appName: macAppName,
    bundleIdentifier: macBundleIdentifier,
    sourceAppBundlePath,
    sourceInfoFingerprint: statFingerprint(join(sourceAppBundlePath, "Contents", "Info.plist")),
    sourceExecutableFingerprint: statFingerprint(electronExecutablePath),
    iconFingerprint: existsSync(macRuntimeIconPath) ? statFingerprint(macRuntimeIconPath) : null,
  };
  const currentMetadata = readJsonFile(macRuntimeMetadataPath);

  if (
    existsSync(macRuntimeExecutablePath) &&
    JSON.stringify(currentMetadata) === JSON.stringify(expectedMetadata)
  ) {
    return macRuntimeExecutablePath;
  }

  mkdirSync(macRuntimeDir, { recursive: true });
  rmSync(macRuntimeAppBundlePath, { recursive: true, force: true });
  cpSync(sourceAppBundlePath, macRuntimeAppBundlePath, {
    recursive: true,
    force: true,
    verbatimSymlinks: true,
  });

  if (existsSync(macRuntimeIconPath)) {
    copyFileSync(
      macRuntimeIconPath,
      join(macRuntimeAppBundlePath, "Contents", "Resources", "icon.icns"),
    );
  }

  patchMacAppBundlePlists(macRuntimeAppBundlePath);
  writeFileSync(macRuntimeMetadataPath, `${JSON.stringify(expectedMetadata, null, 2)}\n`);
  return macRuntimeExecutablePath;
}

export function resolveElectronPath() {
  const electronExecutablePath = resolveInstalledElectronPath();
  if (process.platform !== "darwin") {
    return electronExecutablePath;
  }
  return resolveBrandedMacElectronPath(electronExecutablePath);
}
