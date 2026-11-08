import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
// This build boundary reads exact installed bytes without following package
// links, and publishes only fresh private dependency generations. It never
// edits installed modules or retires a generation that an application may hold.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
  type Stats,
} from "node:fs";
// Native module lookup and copy destinations must preserve host separators.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import runtimePackage from "../../packaging/desktop-runtime/package.json" with { type: "json" };
import { DESKTOP_RUNTIME_FILES } from "./desktop-runtime-files.ts";

export const SOURCE_RUNTIME_DEPENDENCIES = ".source-runtime-dependencies.json";
const require = createRequire(import.meta.url);
const { FileMatcher, excludedExts, excludedNames } =
  require("app-builder-lib/out/fileMatcher.js") as typeof import("app-builder-lib/out/fileMatcher.js");
// The unexported node-module defaults below were reviewed against this exact
// builder. A builder upgrade must review them before admitting local parity.
if ((require("app-builder-lib/package.json") as { version?: unknown }).version !== "26.15.3")
  throw new Error(
    "Review the installed builder's dependency exclusions before building the reduced local runtime.",
  );
const maximumFiles = 50_000;
const maximumBytes = 512 * 1024 * 1024;
const maximumFileBytes = 128 * 1024 * 1024;
const packageName = /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/iu;
const excluded = new Set([
  ...excludedNames.split(","),
  ".DS_Store",
  "node_modules",
  "CHANGELOG.md",
  "ChangeLog",
  "changelog.md",
  "Changelog.md",
  "Changelog",
  "binding.gyp",
  ".npmignore",
  "node_gyp_bins",
]);
const topLevelExcluded = new Set([
  "karma.conf.js",
  ".coveralls.yml",
  "README.md",
  "readme.markdown",
  "README",
  "readme.md",
  "Readme.md",
  "Readme",
  "readme",
  "test",
  "tests",
  "__tests__",
  "powered-test",
  "example",
  "examples",
  ".bin",
]);

function readRegular(file: string, limit = maximumFileBytes): Buffer {
  const named = lstatSync(file, { bigint: true });
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n || named.size > BigInt(limit))
    throw new Error("Unsafe runtime dependency file.");
  const fd = openSync(
    file,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (opened.dev !== named.dev || opened.ino !== named.ino || opened.size !== named.size)
      throw new Error("Runtime dependency changed before reading.");
    const bytes = Buffer.alloc(Number(named.size) + 1);
    let count = 0;
    while (count < bytes.length) {
      const next = readSync(fd, bytes, count, bytes.length - count, null);
      if (next === 0) break;
      count += next;
    }
    const after = fstatSync(fd, { bigint: true });
    const current = lstatSync(file, { bigint: true });
    if (
      BigInt(count) !== named.size ||
      after.nlink !== 1n ||
      after.mtimeNs !== named.mtimeNs ||
      after.ctimeNs !== named.ctimeNs ||
      current.dev !== named.dev ||
      current.ino !== named.ino ||
      current.size !== named.size ||
      current.nlink !== 1n ||
      current.mtimeNs !== named.mtimeNs ||
      current.ctimeNs !== named.ctimeNs
    )
      throw new Error("Runtime dependency changed while reading.");
    return bytes.subarray(0, count);
  } finally {
    closeSync(fd);
  }
}

function privateDirectory(directory: string) {
  const missing: string[] = [];
  for (let current = directory; ; current = dirname(current)) {
    try {
      const metadata = lstatSync(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink())
        throw new Error("Unsafe runtime dependency parent directory.");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.push(current);
    }
  }
  for (const current of missing.toReversed()) {
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const metadata = lstatSync(current);
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        (process.platform !== "win32" &&
          (metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0))
      )
        throw new Error("Unsafe private runtime dependency directory.");
    }
  }
  const metadata = lstatSync(directory);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (process.platform !== "win32" &&
      (metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0))
  )
    throw new Error("Unsafe private runtime dependency directory.");
}

interface Payload {
  readonly file: string;
  readonly bytes: Buffer;
  readonly executable: boolean;
}

/** Uses the same production workspace and shipping exclusions as packaging.
 * Complete selected bytes, paths and executable modes identify the generation;
 * a lock/version marker alone never admits old output. Ancestor dependencies
 * and optional platform packages are resolved only from the installed project.
 */
export function prepareRuntimeDependencies(
  repositoryRoot: string,
  distDirectory: string,
  dependencies: Readonly<Record<string, string>> = runtimePackage.dependencies,
): { file: string; code: string } {
  const root = realpathSync(repositoryRoot);
  const runtimeWorkspace = join(root, "packaging/desktop-runtime");
  const filter = new FileMatcher(root, root, (value) => value, [
    "**/*",
    ...DESKTOP_RUNTIME_FILES,
    `!**/*.{${excludedExts},pdb${process.platform === "win32" ? "" : ",dll,exe"}}`,
    "!**/._*",
  ]).createFilter();
  const payload: Payload[] = [];
  const copied = new Map<string, string>();
  let bytes = 0;
  let packages = 0;
  let entries = 0;
  const admitted = (target: string, metadata: Stats) => filter(join(root, target), metadata);
  const locate = (owner: string, name: string): string | undefined => {
    if (!packageName.test(name)) throw new Error("Unsupported runtime dependency name.");
    for (let current = owner; ; current = dirname(current)) {
      const candidate = join(current, "node_modules", name);
      try {
        const metadata = lstatSync(candidate);
        if (!metadata.isDirectory() || metadata.isSymbolicLink())
          throw new Error("Linked runtime dependencies are unsupported.");
        return candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (current === root) return undefined;
      const parent = dirname(current);
      if (
        parent === current ||
        !relative(root, parent)
          .split(sep)
          .every((part) => part !== "..")
      )
        return undefined;
    }
  };
  const copyPackage = (
    name: string,
    owner: string,
    destination: string,
    optional: boolean,
    depth: number,
  ) => {
    if (depth > 64 || packages > 512)
      throw new Error("Runtime dependency graph exceeds its bound.");
    const synthetic = { isDirectory: () => true } as Stats;
    if (!admitted(destination, synthetic)) return;
    const source = locate(owner, name);
    if (!source) {
      if (optional) return;
      throw new Error(`Required desktop runtime dependency is missing: ${name}`);
    }
    const sourceRelative = relative(root, source).split(sep).join("/");
    if (!sourceRelative.startsWith("node_modules/"))
      throw new Error("Unsupported installed runtime dependency layout.");
    destination = sourceRelative;
    const key = `${name}\0${source}`;
    if (copied.has(key)) return;
    copied.set(key, destination);
    packages++;
    const manifest = JSON.parse(
      readRegular(join(source, "package.json"), 1024 * 1024).toString("utf8"),
    ) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
    const walk = (directory: string, target: string, top: boolean, level = 0) => {
      if (level > 128) throw new Error("Runtime dependency tree exceeds its depth bound.");
      for (const entry of readdirSync(directory, { withFileTypes: true }).toSorted((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (++entries > 150_000)
          throw new Error("Runtime dependency tree exceeds its entry bound.");
        if (
          excluded.has(entry.name) ||
          entry.name.startsWith("._") ||
          (top && topLevelExcluded.has(entry.name))
        )
          continue;
        if (
          directory.endsWith(`${sep}build`) &&
          (entry.name === "gyp-mac-tool" ||
            entry.name === "Makefile" ||
            /\.(?:mk|gypi|Makefile)$/u.test(entry.name))
        )
          continue;
        if (directory.endsWith(`${sep}Release`) && [".deps", "obj.target"].includes(entry.name))
          continue;
        const input = join(directory, entry.name);
        const output = `${target}/${entry.name}`;
        const metadata = lstatSync(input);
        if (!admitted(output, metadata)) continue;
        if (metadata.isSymbolicLink())
          throw new Error("Linked runtime dependency contents are unsupported.");
        if (metadata.isDirectory()) walk(input, output, false, level + 1);
        else if (metadata.isFile()) {
          const data = readRegular(input);
          bytes += data.length;
          if (payload.length >= maximumFiles || bytes > maximumBytes)
            throw new Error("Runtime dependency payload exceeds its bound.");
          payload.push({ file: output, bytes: data, executable: (metadata.mode & 0o111) !== 0 });
        } else throw new Error("Unsupported runtime dependency file.");
      }
    };
    walk(source, destination, true);
    for (const [child, spec] of Object.entries(manifest.dependencies ?? {})) {
      if (/^(?:workspace|file|link|portal):/u.test(spec))
        throw new Error("Unsupported runtime dependency alias.");
      const childSource = locate(source, child);
      copyPackage(
        child,
        source,
        childSource ? relative(root, childSource).split(sep).join("/") : `node_modules/${child}`,
        false,
        depth + 1,
      );
    }
    for (const child of Object.keys(manifest.optionalDependencies ?? {})) {
      const childSource = locate(source, child);
      copyPackage(
        child,
        source,
        childSource ? relative(root, childSource).split(sep).join("/") : `node_modules/${child}`,
        true,
        depth + 1,
      );
    }
  };
  for (const name of Object.keys(dependencies))
    copyPackage(name, runtimeWorkspace, `node_modules/${name}`, false, 0);
  payload.sort((a, b) => a.file.localeCompare(b.file));
  const hash = createHash("sha256").update("cafecode.runtime-dependencies.v1\0");
  for (const item of payload)
    hash
      .update(`${item.file}\0${item.executable ? 1 : 0}\0${item.bytes.length}\0`)
      .update(item.bytes);
  const digest = hash.digest("hex");
  const cache = join(root, "node_modules/.cache/cafecode-runtime-dependencies");
  for (const parent of [join(root, "node_modules"), join(root, "node_modules/.cache")]) {
    try {
      const metadata = lstatSync(parent);
      if (!metadata.isDirectory() || metadata.isSymbolicLink())
        throw new Error("Unsafe runtime dependency cache parent.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        mkdirSync(parent, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const metadata = lstatSync(parent);
        if (!metadata.isDirectory() || metadata.isSymbolicLink())
          throw new Error("Unsafe runtime dependency cache parent.");
      }
    }
  }
  privateDirectory(cache);
  let generation = join(cache, digest);
  const expected = JSON.stringify(
    payload.map((item) => ({
      file: item.file,
      bytes: item.bytes.length,
      executable: item.executable,
      sha256: createHash("sha256").update(item.bytes).digest("hex"),
    })),
  );
  const verify = (directory: string) => {
    const actual: Array<{ file: string; bytes: number; executable: boolean; sha256: string }> = [];
    let total = 0;
    let entries = 0;
    const walk = (current: string, level = 0) => {
      if (level > 128 || ++entries > 150_000)
        throw new Error("Runtime dependency generation exceeds its traversal bound.");
      const metadata = lstatSync(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink())
        throw new Error("Unsafe runtime dependency generation.");
      for (const item of readdirSync(current, { withFileTypes: true })) {
        const filename = join(current, item.name);
        const metadata = lstatSync(filename);
        if (metadata.isDirectory() && !metadata.isSymbolicLink()) walk(filename, level + 1);
        else {
          total += metadata.size;
          if (actual.length >= maximumFiles || total > maximumBytes)
            throw new Error("Runtime dependency generation exceeds its payload bound.");
          const data = readRegular(filename);
          actual.push({
            file: relative(directory, filename).split(sep).join("/"),
            bytes: data.length,
            executable: (metadata.mode & 0o111) !== 0,
            sha256: createHash("sha256").update(data).digest("hex"),
          });
          if (actual.length > maximumFiles)
            throw new Error("Runtime dependency generation exceeds its bound.");
        }
      }
    };
    walk(directory);
    actual.sort((a, b) => a.file.localeCompare(b.file));
    return JSON.stringify(actual) === expected;
  };
  let existing = false;
  try {
    existing = verify(generation);
  } catch {
    /* Corrupt/unsafe/absent candidates never admit reuse. */
  }
  if (!existing) {
    // Exclusive directory creation admits exactly one writer. A concurrent
    // build or corrupt candidate gets a distinct generation, never overwrite
    // or partial reuse of a directory another application/build may hold.
    try {
      mkdirSync(generation, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      generation = `${generation}-${randomUUID()}`;
      mkdirSync(generation, { mode: 0o700 });
    }
    privateDirectory(generation);
    for (const item of payload) {
      const filename = join(generation, item.file);
      privateDirectory(dirname(filename));
      writeFileSync(filename, item.bytes, {
        flag: "wx",
        mode:
          process.platform === "win32"
            ? item.executable
              ? 0o700
              : 0o600
            : item.executable
              ? 0o500
              : 0o400,
      });
    }
    if (!verify(generation))
      throw new Error("New runtime dependency generation failed verification.");
  }
  if (!isAbsolute(generation)) throw new Error("Runtime dependency generation must be absolute.");
  const file = join(distDirectory, SOURCE_RUNTIME_DEPENDENCIES);
  const code = `${JSON.stringify({ version: 1, generation, digest })}\n`;
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, code, { flag: "wx", mode: 0o600 });
  renameSync(temporary, file);
  return { file, code };
}
