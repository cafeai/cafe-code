// @effect-diagnostics nodeBuiltinImport:off
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

interface PackageArchive {
  name: string;
  version: string;
  installPath: string;
  arch: string;
  url: string;
  integrity: string;
}
export interface ManagedProviderManifest {
  version: 1;
  node: string;
  providers: { codex: string; claude: string };
  packages: PackageArchive[];
}
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 512 * 1024 * 1024;

/** Parse only regular npm tar files/directories; links and extensions are
 * refused. Verification precedes extraction, which always targets a fresh tree. */
export async function extractVerifiedProviderArchive(
  bytes: Uint8Array,
  integrity: string,
  destination: string,
) {
  if (
    bytes.byteLength > MAX_ARCHIVE_BYTES ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(integrity) ||
    `sha512-${createHash("sha512").update(bytes).digest("base64")}` !== integrity
  )
    throw new Error("Managed provider archive integrity failed.");
  const tar = gunzipSync(bytes, { maxOutputLength: MAX_EXPANDED_BYTES });
  const seen = new Set<string>();
  let count = 0;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    if (++count > 20_000) throw new Error("Managed provider archive has too many entries.");
    const field = (start: number, end: number) =>
      header.subarray(start, end).toString("utf8").split("\0", 1)[0]!;
    const prefix = field(345, 500);
    const name = `${prefix ? `${prefix}/` : ""}${field(0, 100)}`.replace(/\/$/u, "");
    const sizeText = field(124, 136).trim();
    if (!/^[0-7]+$/u.test(sizeText)) throw new Error("Invalid provider archive size.");
    const size = Number.parseInt(sizeText, 8);
    const type = field(156, 157);
    const parts = name.split("/");
    const relative = parts.slice(1).join("/");
    const checksum = Number.parseInt(field(148, 156).trim(), 8);
    let observed = 0;
    for (let i = 0; i < 512; i++) observed += i >= 148 && i < 156 ? 32 : header[i]!;
    if (
      checksum !== observed ||
      parts[0] !== "package" ||
      !relative ||
      parts.some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[\\:\x00-\x1f]/u.test(part) ||
          /[. ]$/u.test(part) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
      ) ||
      (type !== "" && type !== "0" && type !== "5") ||
      size < 0 ||
      offset + 512 + size > tar.length ||
      seen.has(relative.toLowerCase())
    )
      throw new Error("Unsafe managed provider archive entry.");
    seen.add(relative.toLowerCase());
    const target = path.join(destination, ...parts.slice(1));
    await ensureManagedDirectory(path.dirname(target));
    if (type === "5") await fs.mkdir(target, { recursive: true });
    else
      await fs.writeFile(target, tar.subarray(offset + 512, offset + 512 + size), { flag: "wx" });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (count === 0) throw new Error("Empty managed provider archive.");
}

export async function stageManagedProviders(
  manifest: ManagedProviderManifest,
  arch: "x64" | "arm64",
  destination: string,
) {
  if (manifest.version !== 1 || manifest.packages.length !== 6)
    throw new Error("Invalid managed provider manifest.");
  if (
    manifest.packages.some(
      (entry) => entry.arch !== "all" && entry.arch !== "x64" && entry.arch !== "arm64",
    )
  )
    throw new Error("Invalid managed architecture closure.");
  for (const archive of manifest.packages.filter(
    (entry) => entry.arch === arch || entry.arch === "all",
  )) {
    if (
      !/^@[a-z0-9-]+\/[a-z0-9-]+$/u.test(archive.installPath) ||
      !archive.url.startsWith("https://registry.npmjs.org/")
    )
      throw new Error("Invalid managed provider package identity.");
    const response = await fetch(archive.url, {
      signal: AbortSignal.timeout(120_000),
      redirect: "error",
    });
    if (!response.ok || !response.body) throw new Error("Managed provider download failed.");
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > MAX_ARCHIVE_BYTES) throw new Error("Managed provider download too large.");
      chunks.push(chunk);
    }
    const slug = archive.installPath.startsWith("@openai/") ? "codex" : "claude";
    await extractVerifiedProviderArchive(
      Buffer.concat(chunks),
      archive.integrity,
      path.join(destination, "providers", slug, "node_modules", archive.installPath),
    );
  }
  await fs.writeFile(
    path.join(destination, "runtime-policy.json"),
    JSON.stringify({ node: manifest.node, providers: manifest.providers, arch }),
    { flag: "wx" },
  );
  const codexRoot = path.join(destination, "providers", "codex", "node_modules");
  const claudeRoot = path.join(destination, "providers", "claude", "node_modules");
  // Match the supported native package entrypoint without executing upstream
  // package scripts, downloading mutable releases, or using a package manager.
  await fs.mkdir(path.join(claudeRoot, "@anthropic-ai/claude-code/bin"), { recursive: true });
  await fs.copyFile(
    path.join(claudeRoot, `@anthropic-ai/claude-code-win32-${arch}/claude.exe`),
    path.join(claudeRoot, "@anthropic-ai/claude-code/bin/claude.exe"),
  );
  for (const [slug, root, target] of [
    ["codex", codexRoot, '"%~dp0..\\@openai\\codex\\bin\\codex.js"'],
    ["claude", claudeRoot, '"%~dp0..\\@anthropic-ai\\claude-code\\bin\\claude.exe"'],
  ]) {
    await fs.mkdir(path.join(root!, ".bin"), { recursive: true });
    await fs.writeFile(
      path.join(root!, ".bin", `${slug}.cmd`),
      `@echo off\r\n${slug === "codex" ? '"%~dp0..\\..\\..\\..\\node\\node.exe" ' : ""}${target} %*\r\n`,
      { flag: "wx" },
    );
  }
}

interface BundleEntry {
  path: string;
  bytes: number;
  sha256: string;
}
export async function inventoryManagedBundle(root: string): Promise<BundleEntry[]> {
  const entries: BundleEntry[] = [];
  async function walk(directory: string) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Linked managed bundle entry.");
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) {
        const relative = path.relative(root, absolute).split(path.sep).join("/");
        const data = await fs.readFile(absolute);
        entries.push({
          path: relative,
          bytes: data.length,
          sha256: createHash("sha256").update(data).digest("hex"),
        });
      } else throw new Error("Invalid managed bundle entry.");
    }
  }
  const rootEntry = await fs.lstat(root);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink())
    throw new Error("Linked managed bundle root.");
  await walk(root);
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export async function verifyManagedBundle(root: string, expected: readonly BundleEntry[]) {
  if (!Array.isArray(expected) || expected.length < 1 || expected.length > 30_000)
    throw new Error("Invalid managed inventory.");
  const actual = await inventoryManagedBundle(root);
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error("Managed bundle content verification failed.");
}

async function ensureManagedDirectory(directory: string) {
  let current = path.resolve(directory);
  while (true) {
    try {
      const entry = await fs.lstat(current);
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new Error("Linked managed runtime directory refused.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  await fs.mkdir(directory, { recursive: true });
  const entry = await fs.lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink())
    throw new Error("Managed runtime directory changed.");
}

/** Preparation has no authority to select a runtime or change settings. If the
 * guard-owning installer dies, this child can leave only an unselected tree. */
export async function prepareManagedBundle(input: {
  source: string;
  managedRoot: string;
  probe?: (generation: string) => Promise<void>;
}) {
  const { source, managedRoot } = input;
  if (![source, managedRoot].every((value) => path.isAbsolute(value)))
    throw new Error("Managed runtime paths must be absolute.");
  await ensureManagedDirectory(source);
  await ensureManagedDirectory(managedRoot);
  const generation = randomUUID().replaceAll("-", "");
  const target = path.join(managedRoot, "generations", generation);
  const record = path.join(source, "inventory.json");
  const entry = await fs.lstat(record);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 4 * 1024 * 1024)
    throw new Error("Invalid managed bundle inventory.");
  const inventory = JSON.parse(await fs.readFile(record, "utf8")) as BundleEntry[];
  const content = path.join(source, "content");
  await ensureManagedDirectory(content);
  await verifyManagedBundle(content, inventory);
  await ensureManagedDirectory(path.dirname(target));
  await fs.cp(content, target, { recursive: true, errorOnExist: true, force: false });
  await verifyManagedBundle(target, inventory);
  if (input.probe) await input.probe(target);
  return generation;
}

export const managedCodexExecutable = (generation: string, arch: "x64" | "arm64") =>
  path.join(
    generation,
    `providers/codex/node_modules/@openai/codex-win32-${arch}/vendor/${arch === "arm64" ? "aarch64" : "x86_64"}-pc-windows-msvc/bin/codex.exe`,
  );

async function probeWindowsGeneration(generation: string) {
  const policy = JSON.parse(
    await fs.readFile(path.join(generation, "runtime-policy.json"), "utf8"),
  ) as { node: string; arch: "x64" | "arm64"; providers: { codex: string; claude: string } };
  const probes = [
    [path.join(generation, "node", "node.exe"), ["--version"], `v${policy.node}`],
    [
      managedCodexExecutable(generation, policy.arch),
      ["--version"],
      `codex-cli ${policy.providers.codex}`,
    ],
    [
      path.join(
        generation,
        "providers/claude/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
      ),
      ["--version"],
      `${policy.providers.claude} (Claude Code)`,
    ],
  ] as const;
  for (const [command, args, expected] of probes)
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, [...args], {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
        env: {
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
          PATH: path.join(generation, "node"),
          LOCALAPPDATA: process.env.LOCALAPPDATA,
        },
      });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output = (output + chunk.toString("utf8")).slice(0, 4096);
      });
      // This native wait owns an external child/stream lifetime; a virtual
      // Effect clock must not replace its existing deadline or cleanup.
      // @effect-diagnostics-next-line globalTimers:off
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("Managed runtime version probe timed out."));
      }, 30_000);
      child.once("error", () => {
        clearTimeout(timer);
        reject(new Error("Managed runtime version probe failed."));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        code === 0 && output.trim() === expected
          ? resolve()
          : reject(new Error("Managed runtime version probe failed."));
      });
    });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [operation, source, managedRoot] = process.argv.slice(2);
  if (process.platform !== "win32" || operation !== "--prepare" || !source || !managedRoot)
    throw new Error("Invalid managed installer invocation.");
  const generation = await prepareManagedBundle({
    source,
    managedRoot,
    probe: probeWindowsGeneration,
  });
  process.stdout.write(`${generation}\n`);
}
