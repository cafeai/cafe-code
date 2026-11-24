// Installed native runtime boundary: no-follow metadata, bounded package reads
// and canonical paths qualify code from one explicitly selected OpenAI bundle.
// @effect-diagnostics nodeBuiltinImport:off
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export interface OpenAiComputerInstallation {
  readonly applicationPath: string;
  readonly runtimeRoot: string;
  readonly nodePath: string;
  readonly replPath: string;
  readonly codexPath: string;
  readonly servicePath: string;
  readonly moduleDirectory: string;
}

const packageSchema = z.object({ name: z.string(), version: z.string() });
// These are the installed interfaces qualified by the native fixture. A newer
// package is a new integration contract, not authority to guess its behavior.
const packages = [
  ["sky", "0.7.18"],
  ["cua", "0.2.6"],
  ["cua-repl", "0.1.3"],
] as const;

async function admit(path: string, directory = false, executable = false) {
  if ((await realpath(path)) !== path) throw new Error("Noncanonical computer-use runtime.");
  const stat = await lstat(path, { bigint: true });
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n) ||
    (stat.mode & 0o022n) !== 0n ||
    (stat.uid !== BigInt(process.getuid?.() ?? -1) && stat.uid !== 0n) ||
    (executable && (stat.mode & 0o111n) === 0n)
  )
    throw new Error("Unsafe computer-use runtime entry.");
}

async function readPackage(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat({ bigint: true });
    if (
      !stat.isFile() ||
      stat.nlink !== 1n ||
      stat.size > 64n * 1024n ||
      (stat.mode & 0o022n) !== 0n ||
      (stat.uid !== BigInt(process.getuid?.() ?? -1) && stat.uid !== 0n)
    )
      throw new Error("Unsafe computer-use package.");
    const bytes = Buffer.alloc(64 * 1024 + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (
      BigInt(length) !== stat.size ||
      after.size !== stat.size ||
      after.mtimeNs !== stat.mtimeNs ||
      after.ctimeNs !== stat.ctimeNs
    )
      throw new Error("Computer-use package changed.");
    return packageSchema.parse(JSON.parse(bytes.subarray(0, length).toString("utf8")));
  } finally {
    await file.close();
  }
}

export async function validateOpenAiComputerInstallation(
  installation: OpenAiComputerInstallation,
): Promise<void> {
  if (process.platform !== "darwin") throw new Error("Computer use requires macOS.");
  await admit(installation.applicationPath, true);
  await admit(installation.runtimeRoot, true);
  await admit(installation.moduleDirectory, true);
  for (const executable of [installation.nodePath, installation.replPath, installation.codexPath])
    await admit(executable, false, true);
  await admit(installation.servicePath, true);
  await admit(join(installation.servicePath, "Contents/MacOS/SkyComputerUseService"), false, true);
  for (const [name, version] of packages) {
    const root = join(installation.moduleDirectory, "@oai", name);
    await admit(root, true);
    const metadata = await readPackage(join(root, "package.json"));
    if (metadata.name !== `@oai/${name}` || metadata.version !== version)
      throw new Error("Unsupported OpenAI computer-use runtime version.");
  }
}

/** Fixed installation locations only. This reads program artifacts, never an
 * OpenAI account, profile configuration, authentication file or session. */
export async function resolveOpenAiComputerInstallation(): Promise<
  OpenAiComputerInstallation | undefined
> {
  if (process.platform !== "darwin") return undefined;
  const home = homedir();
  for (const applicationPath of [
    "/Applications/ChatGPT.app",
    "/Applications/Codex.app",
    join(home, "Applications/ChatGPT.app"),
    join(home, "Applications/Codex.app"),
  ]) {
    const runtimeRoot = join(applicationPath, "Contents/Resources/cua_node");
    for (const servicePath of [
      join(home, ".codex/computer-use/Codex Computer Use.app"),
      join(applicationPath, "Contents/Resources/Codex Computer Use.app"),
    ]) {
      const installation: OpenAiComputerInstallation = {
        applicationPath,
        runtimeRoot,
        servicePath,
        nodePath: join(runtimeRoot, "bin/node"),
        replPath: join(runtimeRoot, "bin/node_repl"),
        codexPath: join(
          applicationPath,
          "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
        ),
        moduleDirectory: join(runtimeRoot, "lib/node_modules"),
      };
      try {
        await validateOpenAiComputerInstallation(installation);
        return installation;
      } catch {
        // An unavailable/unsupported candidate grants no execution. Do not
        // inspect profiles, search processes, install or repair another app.
      }
    }
  }
  return undefined;
}
