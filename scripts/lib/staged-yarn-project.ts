import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const projectFiles = [
  "package.json",
  "yarn.lock",
  ".yarnrc.yml",
  "apps/desktop/package.json",
  "apps/server/package.json",
  "apps/web/package.json",
  "oxlint-plugin-cafecode/package.json",
  "packages/client-runtime/package.json",
  "packages/contracts/package.json",
  "packages/effect-acp/package.json",
  "packages/effect-codex-app-server/package.json",
  "packages/shared/package.json",
  "scripts/package.json",
  "scripts/ensure-desktop-runtime.ts",
  "packaging/desktop-runtime/package.json",
] as const;

/** Include patch inputs from both manifests and lockfile, including future patches. */
export function stagedYarnProjectFiles(manifest: string, lockfile: string): readonly string[] {
  const patches = new Set<string>();
  for (const match of `${manifest}\n${lockfile}`.matchAll(/\.yarn\/patches\/[^\s"'#&:]+/gu)) {
    const relative = match[0];
    // Yarn's generated names retain a scope marker and dots in the version.
    // Admit one filename only; parent segments and nested paths stay refused.
    if (!/^\.yarn\/patches\/@?[A-Za-z0-9][A-Za-z0-9._-]*\.patch$/u.test(relative)) {
      throw new Error("Invalid staged Yarn patch path.");
    }
    patches.add(relative);
  }
  return [...projectFiles, ...[...patches].sort()];
}

export const copyStagedYarnProject = Effect.fn("copyStagedYarnProject")(function* (
  repoRoot: string,
  targetRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifest = yield* fs.readFileString(path.join(repoRoot, "package.json"));
  const lockfile = yield* fs.readFileString(path.join(repoRoot, "yarn.lock"));
  const files = stagedYarnProjectFiles(manifest, lockfile);
  // Validate all inputs before copying or invoking Yarn.
  for (const relative of files) {
    if (!(yield* fs.exists(path.join(repoRoot, relative)))) {
      return yield* Effect.die(new Error(`Missing required staged Yarn input: ${relative}`));
    }
  }
  for (const relative of files) {
    const destination = path.join(targetRoot, relative);
    yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
    yield* fs.copyFile(path.join(repoRoot, relative), destination);
  }
});
