import { readFileSync } from "node:fs";
import { join } from "node:path";

const PRELOAD_BUNDLES = ["preload.cjs", "globalDictationPreload.cjs", "visualizationPreload.cjs"];
const SANDBOXED_REQUIRE_MODULES = new Set([
  "electron",
  "events",
  "timers",
  "url",
  "node:events",
  "node:timers",
  "node:url",
]);

/**
 * Electron's sandboxed preloads cannot use Node's ordinary module loader. A
 * shared relative chunk is therefore a runtime startup failure, even though
 * the bundler reports success. Validate the emitted artifact, not merely the
 * tsdown configuration, so a future bundler upgrade cannot reintroduce it.
 */
export function assertSandboxedPreloadSource(source, filename) {
  for (const match of source.matchAll(/\brequire\s*\(([^)]*)\)/gu)) {
    const argument = match[1]?.trim();
    const specifier = /^(["'])([^"']+)\1$/u.exec(argument ?? "")?.[2];
    if (!specifier || !SANDBOXED_REQUIRE_MODULES.has(specifier)) {
      throw new Error(`${filename} imports a module unavailable to Electron's sandboxed preload.`);
    }
  }

  if (/\bimport\s*\(/u.test(source)) {
    throw new Error(
      `${filename} contains a dynamic import unavailable to Electron's sandboxed preload.`,
    );
  }
}

export function assertSandboxedPreloadBundles(desktopDirectory) {
  for (const filename of PRELOAD_BUNDLES) {
    assertSandboxedPreloadSource(
      readFileSync(join(desktopDirectory, "dist-electron", filename), "utf8"),
      filename,
    );
  }
}
