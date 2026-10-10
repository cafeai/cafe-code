import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const MAC_SOURCE_BUNDLE_IDENTIFIER = "com.cafeai.cafecode";

const HELPERS = [
  ["Electron Helper.app", `${MAC_SOURCE_BUNDLE_IDENTIFIER}.helper`],
  ["Electron Helper (Renderer).app", `${MAC_SOURCE_BUNDLE_IDENTIFIER}.helper.renderer`],
  ["Electron Helper (GPU).app", `${MAC_SOURCE_BUNDLE_IDENTIFIER}.helper.gpu`],
  ["Electron Helper (Plugin).app", `${MAC_SOURCE_BUNDLE_IDENTIFIER}.helper.plugin`],
] as const;

interface SigningResult {
  readonly status: number | null;
  readonly stderr: string;
  readonly error?: Error;
}

interface MacSourceSigningOptions {
  readonly run?: (args: readonly string[]) => SigningResult;
}

/** Seal the copied development runtime after branding its plists. Keep the
 * bundled execution policy, while binding each changed app to its Cafe ID.
 * This never signs the installed Electron dependency or a release artifact. */
export function signMacSourceRuntime(
  appBundlePath: string,
  options: MacSourceSigningOptions = {},
): void {
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

  for (const [name, identifier] of HELPERS) {
    const helperPath = join(frameworksPath, name);
    if (!existsSync(helperPath)) continue;
    execute(
      [
        "--force",
        "--sign",
        "-",
        "--identifier",
        identifier,
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
      MAC_SOURCE_BUNDLE_IDENTIFIER,
      "--preserve-metadata=entitlements,flags,runtime",
      appBundlePath,
    ],
    "sign source Cafe Code app",
  );
  execute(["--verify", "--deep", "--strict", appBundlePath], "verify source Cafe Code app");
}
