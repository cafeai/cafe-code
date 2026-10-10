import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import release from "../native/cua-driver/release.json" with { type: "json" };
import policy from "../native/cua-driver/build.json" with { type: "json" };
import { verifyNativeRuntime } from "../packages/shared/src/nativeRuntime.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function run(
  command: string,
  args: readonly string[],
  cwd: string,
  capture = false,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
    });
    let output = "";
    child.stdout?.on("data", (bytes: Buffer) => {
      output += bytes.toString("utf8");
      if (output.length > 32 * 1024 * 1024) {
        child.kill();
        reject(new Error("Build metadata exceeded its bound."));
      }
    });
    child.once("error", () =>
      reject(new Error(`Required native build tool ${command} is unavailable.`)),
    );
    child.once("exit", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`Native build step ${command} failed.`));
    });
  });
}

async function main(): Promise<void> {
  if (process.argv.length > 3 || (process.argv.length === 3 && process.argv[2] !== "--force"))
    throw new Error(
      "Prepare the runtime for the current host; no arbitrary source or executable options are accepted.",
    );
  if (process.platform !== "darwin")
    throw new Error("Native Cua preparation is currently macOS-only.");
  if (policy.sourceCommit !== release.sourceCommit)
    throw new Error("Cua source pin and reviewed patch policy differ.");
  const patchPath = join(root, "native/cua-driver/local-only.patch");
  if (hash(await fs.readFile(patchPath)) !== policy.patchSha256)
    throw new Error("Cua source patch failed its reviewed hash check.");
  const runtimeRoot = join(
    root,
    "native/cua-driver/runtime",
    `${process.platform}-${process.arch}`,
  );
  if (
    process.argv[2] !== "--force" &&
    (await verifyNativeRuntime(runtimeRoot).then(
      () => true,
      () => false,
    ))
  ) {
    process.stdout.write(`Verified Cua ${release.version} runtime is already prepared.\n`);
    return;
  }
  const reviewRoot = join(root, ".explorations/cua-driver");
  await fs.mkdir(reviewRoot, { recursive: true, mode: 0o700 });
  const sourceRoot = await fs.mkdtemp(join(reviewRoot, "source-"));
  await run("git", ["init", "--quiet"], sourceRoot);
  await run("git", ["remote", "add", "origin", "https://github.com/trycua/cua.git"], sourceRoot);
  await run("git", ["config", "core.sparseCheckout", "true"], sourceRoot);
  await fs.writeFile(join(sourceRoot, ".git/info/sparse-checkout"), "/libs/cua-driver/\n", {
    flag: "wx",
  });
  await run(
    "git",
    ["fetch", "--filter=blob:none", "--depth", "1", "origin", release.sourceCommit],
    sourceRoot,
  );
  await run("git", ["checkout", "--detach", "FETCH_HEAD"], sourceRoot);
  if ((await run("git", ["rev-parse", "HEAD"], sourceRoot, true)).trim() !== release.sourceCommit)
    throw new Error("Cua source checkout identity differs from the pin.");
  await run("git", ["apply", "--check", patchPath], sourceRoot);
  await run("git", ["apply", patchPath], sourceRoot);
  const rustRoot = join(sourceRoot, "libs/cua-driver/rust");
  await run("cargo", ["build", "--release", "--locked", "-p", "cua-driver"], rustRoot);
  const metadata = await run(
    "cargo",
    ["metadata", "--locked", "--format-version", "1"],
    rustRoot,
    true,
  );
  const temporary = await fs.mkdtemp(join(reviewRoot, "runtime-"));
  const binary = "cua-driver";
  // Cargo may use CARGO_TARGET_DIR for a shared build cache. Read the output
  // from this build's own metadata instead of assuming a local target folder.
  const targetDirectory = (JSON.parse(metadata) as { target_directory?: unknown }).target_directory;
  if (typeof targetDirectory !== "string" || !isAbsolute(targetDirectory))
    throw new Error("Native build metadata has no absolute output directory.");
  const bytes = await fs.readFile(join(targetDirectory, "release", binary));
  await fs.writeFile(join(temporary, binary), bytes, { flag: "wx", mode: 0o755 });
  await fs.writeFile(
    join(temporary, "manifest.json"),
    `${JSON.stringify({ schemaVersion: 1, version: release.version, sourceCommit: release.sourceCommit, patchSha256: policy.patchSha256, platform: process.platform, arch: process.arch, binary, sha256: hash(bytes), integrationApproved: true, qualification: "reviewed-source-development-build; native GUI qualification required" }, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  await fs.writeFile(join(temporary, "dependency-metadata.json"), metadata, {
    flag: "wx",
    mode: 0o600,
  });
  for (const name of ["LICENSE.txt", "THIRD_PARTY_NOTICES.md", "local-only.patch"])
    await fs.copyFile(join(root, "native/cua-driver", name), join(temporary, name));
  await fs.mkdir(dirname(runtimeRoot), { recursive: true, mode: 0o700 });
  // A rebuild replaces only the fixed Cafe-owned development runtime. It
  // cannot select a provider profile, installed system binary or arbitrary path.
  const current = await fs.lstat(runtimeRoot).catch(() => undefined);
  if (current && (!current.isDirectory() || current.isSymbolicLink()))
    throw new Error("Unsafe Cua runtime destination.");
  if (current) {
    const prior = `${runtimeRoot}.previous-${Date.now()}`;
    await fs.rename(runtimeRoot, prior);
  }
  await fs.rename(temporary, runtimeRoot);
  await verifyNativeRuntime(runtimeRoot);
  process.stdout.write(
    `Reviewed Cua ${release.version} runtime prepared at ${runtimeRoot}. Enable local desktop control in Settings → MCP, then check permissions and test a screenshot.\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Cua preparation failed."}\n`);
  process.exitCode = 1;
});
