// This boundary retains exact native child handles and close/signal ownership.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
// Native checkout/fixture IO retains its existing descriptor, identity and lifetime semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { existsSync, readdirSync, realpathSync } from "node:fs";
// Host-native path spelling must agree with the existing native file and tool boundary.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { isAbsolute, join } from "node:path";

// Only copied source runtimes consume this identity. Production's signed
// bundle and installed Electron are deliberately outside this module's scope.
export const MAC_SOURCE_APP_NAME = "Cafe Code (Debug)";
export const MAC_SOURCE_BUNDLE_IDENTIFIER = "com.cafeai.cafecode.debug";
export const MAC_SOURCE_RUNTIME_CACHE_KEY = "debug-runtime-v2";

/** A canonical checkout has one notification/application identity. Different
 * checkouts must not compete for the same LaunchServices activation record. */
export function resolveMacSourceRuntimeBundleIdentifier(desktopDirectory: string): string {
  if (!isAbsolute(desktopDirectory))
    throw new Error("Source runtime identity requires an absolute directory.");
  const key = createHash("sha256")
    .update("cafecode.source-runtime.v2\0")
    .update(realpathSync(desktopDirectory))
    .digest("hex")
    .slice(0, 24);
  return `${MAC_SOURCE_BUNDLE_IDENTIFIER}.runtime.${key}`;
}

function qualifyBundleIdentifier(identifier: string): string {
  if (
    identifier !== MAC_SOURCE_BUNDLE_IDENTIFIER &&
    !/^com\.cafeai\.cafecode\.debug\.runtime\.[a-f0-9]{24}$/u.test(identifier)
  )
    throw new Error("Invalid source runtime bundle identity.");
  return identifier;
}

/** Never reuse or delete a pre-profile cache while staging the new identity. */
export function resolveMacSourceRuntimeDirectory(desktopDirectory: string): string {
  return join(desktopDirectory, ".electron-runtime", MAC_SOURCE_RUNTIME_CACHE_KEY);
}

const HELPERS = [
  ["Electron Helper.app", "helper"],
  ["Electron Helper (Renderer).app", "helper.renderer"],
  ["Electron Helper (GPU).app", "helper.gpu"],
  ["Electron Helper (Plugin).app", "helper.plugin"],
] as const;

interface SigningResult {
  readonly status: number | null;
  readonly stderr: string;
  readonly error?: Error;
}

interface MacSourceSigningOptions {
  readonly run?: (args: readonly string[]) => SigningResult;
  readonly bundleIdentifier?: string;
}

/** Seal the copied development runtime after branding its plists. Keep the
 * bundled execution policy, while binding each changed app to its Cafe ID.
 * This never signs the installed Electron dependency or a release artifact. */
export function signMacSourceRuntime(
  appBundlePath: string,
  options: MacSourceSigningOptions = {},
): void {
  const bundleIdentifier = qualifyBundleIdentifier(
    options.bundleIdentifier ?? MAC_SOURCE_BUNDLE_IDENTIFIER,
  );
  const run =
    options.run ??
    ((args: readonly string[]) =>
      spawnSync("codesign", [...args], { encoding: "utf8", shell: false }));
  const execute = (args: readonly string[], description: string) => {
    const result = run(args);
    if (result.status !== 0 || result.error) {
      const message = result.error?.message || result.stderr.trim() || "codesign failed";
      throw new Error(`Failed to ${description}: ${message}`);
    }
  };
  const frameworksPath = join(appBundlePath, "Contents", "Frameworks");

  // Some shipped frameworks have only linker signatures. Seal those bundles
  // too, before sealing the parent; do not change their vendor identifiers.
  for (const entry of readdirSync(frameworksPath, { withFileTypes: true }).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isDirectory() || !entry.name.endsWith(".framework")) continue;
    execute(
      [
        "--force",
        "--sign",
        "-",
        "--preserve-metadata=identifier,entitlements,flags,runtime",
        join(frameworksPath, entry.name),
      ],
      `sign source framework ${entry.name}`,
    );
  }

  for (const [name, suffix] of HELPERS) {
    const helperPath = join(frameworksPath, name);
    if (!existsSync(helperPath)) continue;
    execute(
      [
        "--force",
        "--sign",
        "-",
        "--identifier",
        `${bundleIdentifier}.${suffix}`,
        "--preserve-metadata=entitlements,flags,runtime",
        helperPath,
      ],
      `sign source helper ${name}`,
    );
  }

  execute(
    [
      "--force",
      "--sign",
      "-",
      "--identifier",
      bundleIdentifier,
      "--preserve-metadata=entitlements,flags,runtime",
      appBundlePath,
    ],
    "sign source Cafe Code app",
  );
  execute(["--verify", "--deep", "--strict", appBundlePath], "verify source Cafe Code app");
}

interface MacSourceRegistrationOptions {
  readonly run?: (command: string, args: readonly string[]) => SigningResult;
  readonly bundleIdentifier?: string;
}

/** Native notification activation resolves a bundle identifier through
 * LaunchServices. The immutable host launches Electron with NSTask, which
 * does not refresh that registration when a different checkout wins it.
 * Register this exact verified Debug copy on every launch, including cache
 * hits. Never reset the database, unregister other apps, launch a process or
 * change a signature here. */
export function registerMacSourceRuntime(
  appBundlePath: string,
  options: MacSourceRegistrationOptions = {},
): void {
  const bundleIdentifier = qualifyBundleIdentifier(
    options.bundleIdentifier ?? MAC_SOURCE_BUNDLE_IDENTIFIER,
  );
  if (!isAbsolute(appBundlePath) || !appBundlePath.endsWith(".app"))
    throw new Error("Source runtime registration requires an absolute app bundle path.");
  const run =
    options.run ??
    ((command: string, args: readonly string[]) =>
      spawnSync(command, [...args], {
        encoding: "utf8",
        shell: false,
        timeout: 10_000,
        killSignal: "SIGKILL",
        maxBuffer: 8192,
      }));
  const execute = (command: string, args: readonly string[], message: string) => {
    try {
      const result = run(command, args);
      if (result.status === 0 && !result.error) return;
    } catch {
      /* Received native errors are opaque; no coercion or output forwarding. */
    }
    throw new Error(message);
  };
  execute(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", "-R", `=identifier "${bundleIdentifier}"`, appBundlePath],
    "Source runtime registration refused an invalid Debug app signature.",
  );
  execute(
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
    ["-f", appBundlePath],
    "Could not register the source Cafe Code app for native activation.",
  );
}
