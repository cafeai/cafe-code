import * as fs from "node:fs/promises";
import { join } from "node:path";
import { verifyNativeRuntime } from "@cafecode/shared/nativeRuntime";

/** Ordinary artifact builds stay offline. Stage only an explicitly prepared,
 * matching Mac runtime; invalid prepared bytes fail the artifact build. */
export async function stageNativeCuaRuntime(
  repoRoot: string,
  resources: string,
  platform: string,
  arch: string,
): Promise<boolean> {
  if (platform !== "mac" || !["arm64", "x64"].includes(arch)) return false;
  const source = join(repoRoot, "native/cua-driver/runtime", `darwin-${arch}`);
  const exists = await fs.lstat(source).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  });
  if (!exists) return false;
  await verifyNativeRuntime(source, { platform: "darwin", arch });
  const destination = join(resources, "cua-driver");
  await fs.mkdir(destination, { recursive: false });
  for (const name of ["cua-driver", "manifest.json"])
    await fs.copyFile(join(source, name), join(destination, name));
  // Build provenance contains no credential. Installed apps may be owned by
  // an administrator, so it must remain readable by the launching user.
  await fs.chmod(join(destination, "manifest.json"), 0o644);
  await fs.chmod(join(destination, "cua-driver"), 0o755);
  for (const name of ["LICENSE.txt", "THIRD_PARTY_NOTICES.md", "local-only.patch"])
    await fs.copyFile(join(repoRoot, "native/cua-driver", name), join(destination, name));
  await verifyNativeRuntime(destination, { platform: "darwin", arch });
  return true;
}
