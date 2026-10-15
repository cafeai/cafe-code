// @effect-diagnostics nodeBuiltinImport:off
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { execFileSync } from "node:child_process";
import { readdir, readFile, writeFile, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const targets = ["windows-x64", "macos-arm64", "macos-x64", "linux-x64"] as const;
const evidenceName = "artifact-evidence.json";
interface Evidence {
  version: 1;
  source: string;
  target: string;
  files: { name: string; bytes: number; sha256: string }[];
}
async function inventory(directory: string) {
  const files: Evidence["files"] = [];
  for (const name of (await readdir(directory)).sort()) {
    if (name === evidenceName) continue;
    const file = join(directory, name);
    const info = await lstat(file);
    // Only published top-level assets participate. Builder unpacked directories
    // remain local; symlinks can never stand in for uploaded evidence.
    if (info.isSymbolicLink()) throw new Error("Linked release asset refused.");
    if (info.isDirectory()) continue;
    if (!info.isFile()) throw new Error("Invalid release asset.");
    const digest = createHash("sha256");
    let bytes = 0;
    for await (const chunk of createReadStream(file)) {
      digest.update(chunk);
      bytes += chunk.length;
    }
    const after = await lstat(file);
    if (
      after.dev !== info.dev ||
      after.ino !== info.ino ||
      after.size !== info.size ||
      bytes !== info.size ||
      after.mtimeMs !== info.mtimeMs
    )
      throw new Error("Release asset changed while sealing.");
    files.push({ name, bytes, sha256: digest.digest("hex") });
  }
  if (files.length === 0) throw new Error("No release assets to qualify.");
  return files;
}
export async function sealReleaseArtifacts(directory: string, source: string, target: string) {
  if (!/^[a-f0-9]{40}$/u.test(source) || !targets.includes(target as (typeof targets)[number]))
    throw new Error("Invalid release candidate identity.");
  const evidence: Evidence = { version: 1, source, target, files: await inventory(directory) };
  await writeFile(join(directory, evidenceName), JSON.stringify(evidence, null, 2) + "\n", {
    flag: "wx",
  });
}
export async function verifyReleaseArtifacts(root: string, source: string) {
  if (!/^[a-f0-9]{40}$/u.test(source)) throw new Error("Invalid release source.");
  const expected = targets.map((target) => `cafe-code-release-${target}`).sort();
  if (JSON.stringify((await readdir(root)).sort()) !== JSON.stringify(expected))
    throw new Error("Incomplete release candidate artifact matrix.");
  for (const target of targets) {
    const directory = join(root, `cafe-code-release-${target}`);
    const record = join(directory, evidenceName);
    const info = await lstat(record);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)
      throw new Error("Invalid release evidence.");
    const evidence = JSON.parse(await readFile(record, "utf8")) as Evidence;
    if (
      evidence.version !== 1 ||
      evidence.source !== source ||
      evidence.target !== target ||
      JSON.stringify(evidence.files) !== JSON.stringify(await inventory(directory))
    )
      throw new Error("Release assets differ from their qualified source or bytes.");
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [mode, directory, shaFlag, sha, targetFlag, target] = process.argv.slice(2);
  if (!directory || shaFlag !== "--sha" || !sha)
    throw new Error("Expected --write/--verify <directory> --sha <commit> [--target <target>].");
  if (execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== sha)
    throw new Error("Checkout does not match the release commit.");
  if (mode === "--write" && targetFlag === "--target" && target)
    await sealReleaseArtifacts(directory, sha, target);
  else if (mode === "--verify") await verifyReleaseArtifacts(directory, sha);
  else throw new Error("Invalid release evidence command.");
}
