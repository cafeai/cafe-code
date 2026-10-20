import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
// Native checkout/fixture IO retains its existing descriptor, identity and lifetime semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { lstat, mkdtemp, realpath, rename, rm, rmdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
// Host-native path spelling must agree with the existing native file and tool boundary.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
// Resolve through the workspace that declares tsdown, not accidental root hoisting.
export type BrowserBridgeConfiguration =
  (typeof import("../../apps/server/tsdown.config.ts"))["default"][number];

export interface BrowserArtifactDirectory {
  readonly path: string;
  readonly device: string;
  readonly inode: string;
}

const directoryPrefix = "cafe-browser-artifacts-";
const bridgeEntries = {
  "mcp-bridge": "src/mcp/localBridgeEntry.ts",
  "scheduling-mcp-bridge": "src/mcp/schedulingBridgeEntry.ts",
  "visualization-mcp-bridge": "src/mcp/visualizationBridgeEntry.ts",
} as const;

/** Keep only the shipping entry configurations actually copied by the isolated
 * bridge fixture. In particular, do not reimplement its dependency bundling or
 * code-splitting policy in a cheaper, non-shipping test configuration. */
export function selectBrowserBridgeConfigurations(
  configurations: readonly BrowserBridgeConfiguration[],
): readonly BrowserBridgeConfiguration[] {
  return Object.entries(bridgeEntries).map(([name, entry]) => {
    const matches = configurations.filter((configuration) => {
      const configuredEntry = configuration.entry;
      return (
        configuredEntry !== null &&
        typeof configuredEntry === "object" &&
        !Array.isArray(configuredEntry) &&
        Object.keys(configuredEntry).length === 1 &&
        Object.hasOwn(configuredEntry, name) &&
        configuredEntry[name] === entry
      );
    });
    if (matches.length !== 1)
      throw new Error(
        "A required shipping MCP bridge build configuration is ambiguous or missing.",
      );
    return matches[0]!;
  });
}

export async function assertBrowserArtifactDirectory(
  directory: BrowserArtifactDirectory,
): Promise<void> {
  const { path } = directory;
  const temporaryRoot = await realpath(tmpdir());
  if (
    dirname(path) !== temporaryRoot ||
    !new RegExp(`^${directoryPrefix}[a-zA-Z0-9]{6}$`).test(basename(path))
  ) {
    throw new Error("The browser fixture directory is outside its owned temporary namespace.");
  }
  await assertPrivateDirectoryIdentity(directory);
}

async function assertPrivateDirectoryIdentity({ path, device, inode }: BrowserArtifactDirectory) {
  const stat = await lstat(path, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.dev.toString() !== device ||
    stat.ino.toString() !== inode ||
    (process.platform !== "win32" &&
      ((stat.mode & 0o077n) !== 0n || stat.uid !== BigInt(process.getuid!())))
  ) {
    throw new Error("The browser fixture directory no longer has its exact private owner.");
  }
}

/** Retire only after successful joined fixture scopes. Rename first into a
 * fresh private quarantine, then validate the transferred inode: an ordinary
 * replacement of the source path must never become a recursive-delete target.
 * This is a source-owned fixture boundary, not a defense against a malicious
 * same-UID actor who can also rewrite this runner or its private quarantine. */
async function retireBrowserArtifactDirectory(directory: BrowserArtifactDirectory) {
  await assertBrowserArtifactDirectory(directory);
  const quarantine = await mkdtemp(join(await realpath(tmpdir()), `${directoryPrefix}retired-`));
  const stat = await lstat(quarantine, { bigint: true });
  const quarantineOwner = {
    path: quarantine,
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
  };
  const retired = join(quarantine, "retired");
  // Any uncertainty retains both names. Never recover by deleting a presumed
  // replacement, and never recursively remove the quarantine parent itself.
  await assertPrivateDirectoryIdentity(quarantineOwner);
  await assertBrowserArtifactDirectory(directory);
  await rename(directory.path, retired);
  await assertPrivateDirectoryIdentity({ ...directory, path: retired });
  await assertPrivateDirectoryIdentity(quarantineOwner);
  await rm(retired, { recursive: true });
  await assertPrivateDirectoryIdentity(quarantineOwner);
  await rmdir(quarantine);
}

/** Failed/cancelled callbacks retain their artifacts: direct command closure
 * does not prove arbitrary descendants have retired. Successful existing
 * Vitest/MCP scopes join their owned children before returning. */
export async function withBrowserArtifactDirectory<T>(
  use: (directory: BrowserArtifactDirectory) => Promise<T>,
): Promise<T> {
  const path = await mkdtemp(join(await realpath(tmpdir()), directoryPrefix));
  const stat = await lstat(path, { bigint: true });
  const directory = Object.freeze({
    path,
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
  });
  await assertBrowserArtifactDirectory(directory);
  Effect.runSync(Console.log(`Browser fixture artifacts (retained on failure): ${path}`));
  const value = await use(directory);
  await retireBrowserArtifactDirectory(directory);
  return value;
}

export async function buildBrowserBridgeFixtures(
  repositoryRoot: string,
  directory: BrowserArtifactDirectory,
): Promise<void> {
  const ownedDirectory = Object.freeze({ ...directory });
  await assertBrowserArtifactDirectory(ownedDirectory);
  const serverRoot = resolve(repositoryRoot, "apps/server");
  // The real config only constructs build options and version receipts; it
  // does not import an application entrypoint or start a server/provider.
  const { default: shippingConfigurations } = await import("../../apps/server/tsdown.config.ts");
  const configurations = selectBrowserBridgeConfigurations(shippingConfigurations);
  const serverRequire = createRequire(resolve(serverRoot, "package.json"));
  const { build } = (await import(pathToFileURL(serverRequire.resolve("tsdown")).href)) as {
    readonly build: (
      options: BrowserBridgeConfiguration & {
        readonly config: false;
        readonly cwd: string;
        readonly outDir: string;
        readonly clean: false;
        readonly concurrency: number;
      },
    ) => Promise<unknown>;
  };
  for (const configuration of configurations) {
    await assertBrowserArtifactDirectory(ownedDirectory);
    await build({
      ...configuration,
      config: false,
      cwd: serverRoot,
      outDir: ownedDirectory.path,
      clean: false,
      concurrency: 1,
    });
  }
  await assertBrowserArtifactDirectory(ownedDirectory);
  for (const name of Object.keys(bridgeEntries)) {
    const file = await lstat(join(ownedDirectory.path, `${name}.mjs`), { bigint: true });
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1n || file.size === 0n)
      throw new Error("A required isolated MCP bridge bundle was not freshly produced.");
  }
}
