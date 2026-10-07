import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import release from "../../../native/cua-driver/release.json" with { type: "json" };
import policy from "../../../native/cua-driver/build.json" with { type: "json" };

async function readRegular(path: string, limit: number, executable = false): Promise<Buffer> {
  const file = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await file.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.size > BigInt(limit) ||
      (executable && process.platform !== "win32" && (before.mode & 0o111n) === 0n)
    )
      throw new Error("Invalid Cua runtime file.");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > limit) throw new Error("Cua runtime file exceeded its bound.");
      chunks.push(chunk);
    }
    const after = await file.stat({ bigint: true });
    const named = await fs.lstat(path, { bigint: true });
    if (
      named.isSymbolicLink() ||
      named.dev !== before.dev ||
      named.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      size !== Number(before.size)
    )
      throw new Error("Cua runtime changed during verification.");
    return Buffer.concat(chunks);
  } finally {
    await file.close();
  }
}

/** Target selection is only for artifact staging. Actual launch always uses
 * the current host. Unsupported platforms cannot admit a forged manifest. */
export async function verifyNativeRuntime(
  root: string,
  target = {
    platform: process.platform as string,
    arch: process.arch as string,
  },
): Promise<string> {
  if (target.platform !== "darwin" || !policy.reviewedPlatforms.includes(target.platform))
    throw new Error("Native Cua is enabled only on macOS.");
  const directory = await fs.lstat(root);
  if (!directory.isDirectory() || directory.isSymbolicLink())
    throw new Error("Invalid Cua runtime directory.");
  const manifest = JSON.parse(
    (await readRegular(join(root, "manifest.json"), 16 * 1024)).toString("utf8"),
  ) as Record<string, unknown>;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.version !== release.version ||
    manifest.sourceCommit !== release.sourceCommit ||
    policy.sourceCommit !== release.sourceCommit ||
    manifest.patchSha256 !== policy.patchSha256 ||
    manifest.platform !== target.platform ||
    manifest.arch !== target.arch ||
    !["arm64", "x64"].includes(target.arch) ||
    manifest.integrationApproved !== true ||
    manifest.binary !== "cua-driver" ||
    typeof manifest.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(manifest.sha256)
  )
    throw new Error("The Cua runtime does not match the reviewed host and source pin.");
  const executable = join(root, "cua-driver");
  const bytes = await readRegular(executable, 128 * 1024 * 1024, true);
  if (createHash("sha256").update(bytes).digest("hex") !== manifest.sha256)
    throw new Error("Cua executable failed its integrity check.");
  return executable;
}
