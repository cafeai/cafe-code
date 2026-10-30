import { createRequire, isBuiltin, registerHooks, type ModuleHooks } from "node:module";
// Bootstrap-only native reads admit the exact dependency pointer before any
// application module or runtime layer can load; they retain no-follow, bounded
// single-link descriptors and never inspect or change a data profile.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
// Native loader URLs and filesystem module names must share host semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SOURCE_RUNTIME_DEPENDENCIES = ".source-runtime-dependencies.json";

function within(root: string, filename: string): boolean {
  const child = relative(root, filename);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

function readPointer(filename: string): unknown {
  const named = lstatSync(filename, { bigint: true });
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n || named.size > 16_384n)
    throw new Error("Invalid application runtime dependency metadata.");
  const descriptor = openSync(
    filename,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (opened.dev !== named.dev || opened.ino !== named.ino || opened.size !== named.size)
      throw new Error("Application runtime dependency metadata changed.");
    const bytes = Buffer.alloc(Number(named.size) + 1);
    let count = 0;
    while (count < bytes.length) {
      const next = readSync(descriptor, bytes, count, bytes.length - count, null);
      if (next === 0) break;
      count += next;
    }
    const after = fstatSync(descriptor, { bigint: true });
    const current = lstatSync(filename, { bigint: true });
    if (
      BigInt(count) !== named.size ||
      after.nlink !== 1n ||
      after.mtimeNs !== named.mtimeNs ||
      after.ctimeNs !== named.ctimeNs ||
      current.dev !== named.dev ||
      current.ino !== named.ino ||
      current.nlink !== 1n ||
      current.mtimeNs !== named.mtimeNs ||
      current.ctimeNs !== named.ctimeNs
    )
      throw new Error("Application runtime dependency metadata changed.");
    return JSON.parse(bytes.subarray(0, count).toString("utf8"));
  } finally {
    closeSync(descriptor);
  }
}

/** Development's physically filtered tree is the only dependency root. A
 * missing package/file must never be rescued by a larger ancestor checkout.
 * This is dependency parity, not a filesystem or untrusted-code sandbox.
 */
export function installRuntimeDependencyRoot(generation: string): ModuleHooks {
  const canonical = realpathSync(generation);
  const modules = join(canonical, "node_modules");
  const metadata = lstatSync(modules);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error("Missing reduced application runtime. Rebuild using yarn build:desktop.");
  if (typeof registerHooks !== "function")
    throw new Error("This runtime does not support the qualified application dependency loader.");
  const anchor = pathToFileURL(join(canonical, "runtime-entry.mjs")).href;
  const anchoredRequire = createRequire(anchor);
  let resolvingCommonJs = false;
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      if (resolvingCommonJs) return nextResolve(specifier, context);
      if (isBuiltin(specifier) || specifier === "electron") return nextResolve(specifier, context);
      const bare =
        !specifier.startsWith(".") &&
        !specifier.startsWith("/") &&
        !specifier.startsWith("#") &&
        !/^[a-z][a-z0-9+.-]*:/iu.test(specifier);
      const parent = context.parentURL?.startsWith("file:")
        ? fileURLToPath(context.parentURL)
        : undefined;
      const redirect = bare && (!parent || !within(canonical, parent));
      let request = specifier;
      if (redirect && context.conditions.includes("require")) {
        // Node's synchronous CommonJS resolver retains its original Module
        // parent even when a hook changes parentURL. Resolve from an explicit
        // createRequire anchor, then pass the resulting exact file through
        // the ordinary loader. The nested resolution is synchronous and its
        // result is checked below before any package code can execute.
        resolvingCommonJs = true;
        try {
          request = anchoredRequire.resolve(specifier);
        } finally {
          resolvingCommonJs = false;
        }
      }
      const result = nextResolve(request, redirect ? { ...context, parentURL: anchor } : context);
      if (result.url.startsWith("file:")) {
        const filename = fileURLToPath(result.url);
        const unpacked = canonical.endsWith(".asar") && within(`${canonical}.unpacked`, filename);
        if (
          (bare || filename.split(sep).includes("node_modules")) &&
          !within(canonical, filename) &&
          !unpacked
        ) {
          const error = new Error(
            "Dependency is unavailable in the shipped application runtime.",
          ) as NodeJS.ErrnoException;
          error.code = "MODULE_NOT_FOUND";
          throw error;
        }
      }
      return result;
    },
  });
}

/** Published standalone npm CLI dependencies retain their ordinary package
 * manager contract. Desktop artifacts have the exact staged runtime marker;
 * source builds must carry their private, byte-bound dependency pointer.
 */
export function installApplicationRuntimeDependencies(
  entry: string | URL,
): ModuleHooks | undefined {
  const filename = entry instanceof URL ? fileURLToPath(entry) : entry;
  const directory = dirname(filename);
  const appRoot = resolve(directory, "../../..");
  if (process.versions.electron && appRoot.endsWith(".asar")) {
    // Electron's virtual ASAR entries and their extracted open descriptors do
    // not share native inode identities. Only this exact packaged manifest
    // uses the bounded virtual reader; native source pointers retain all of
    // readPointer's no-follow, bigint, single-link and change fences.
    const manifest = readAsarRuntimeManifest(join(appRoot, "package.json"));
    if (
      manifest.name !== "@cafecode/desktop-runtime" ||
      manifest.private !== true ||
      manifest.devDependencies ||
      manifest.workspaces ||
      manifest.scripts
    )
      throw new Error("Invalid packaged runtime dependency manifest.");
    return installRuntimeDependencyRoot(appRoot);
  }
  let candidate: unknown;
  let pointerPresent = false;
  try {
    candidate = readPointer(join(directory, SOURCE_RUNTIME_DEPENDENCIES));
    pointerPresent = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (pointerPresent) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      throw new Error("Invalid reduced runtime dependency pointer.");
    const pointer = candidate as Record<string, unknown>;
    if (
      pointer.version !== 1 ||
      typeof pointer.generation !== "string" ||
      !isAbsolute(pointer.generation) ||
      typeof pointer.digest !== "string" ||
      !/^[a-f0-9]{64}$/u.test(pointer.digest)
    )
      throw new Error("Invalid reduced runtime dependency pointer.");
    return installRuntimeDependencyRoot(pointer.generation);
  }
  try {
    const manifest = readPointer(join(appRoot, "package.json")) as Record<string, unknown>;
    if (
      manifest.name === "@cafecode/desktop-runtime" &&
      manifest.private === true &&
      !manifest.devDependencies &&
      !manifest.workspaces &&
      !manifest.scripts
    )
      return installRuntimeDependencyRoot(appRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (
    let current = dirname(directory), depth = 0;
    depth < 8;
    current = dirname(current), depth++
  ) {
    try {
      const manifest = readPointer(join(current, "package.json")) as Record<string, unknown>;
      if (
        manifest.name === "@cafeai/cafe-code" &&
        !manifest.devDependencies &&
        !manifest.scripts &&
        !manifest.workspaces
      )
        return undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (dirname(current) === current) break;
  }
  throw new Error(
    "Reduced application runtime is missing. Rebuild using yarn build:desktop before starting Cafe Code.",
  );
}

function readAsarRuntimeManifest(filename: string): Record<string, unknown> {
  const metadata = lstatSync(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16_384)
    throw new Error("Invalid packaged runtime dependency manifest.");
  const descriptor = openSync(filename, constants.O_RDONLY);
  try {
    const buffer = Buffer.alloc(16_385);
    let count = 0;
    while (count < buffer.length) {
      const next = readSync(descriptor, buffer, count, buffer.length - count, null);
      if (next === 0) break;
      count += next;
    }
    if (count !== metadata.size || count > 16_384)
      throw new Error("Invalid packaged runtime dependency manifest.");
    const value: unknown = JSON.parse(buffer.subarray(0, count).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid packaged runtime dependency manifest.");
    return value as Record<string, unknown>;
  } finally {
    closeSync(descriptor);
  }
}

/** A fixed extraction child imports its library only after this guard is
 * installed. Its root comes from the already resolved library URL, never an
 * inherited NODE_OPTIONS hook or a provider execution environment.
 */
export function runtimeDependencyChildBootstrapSource(): string {
  return `import { registerHooks as registerRuntimeHooks, isBuiltin as runtimeIsBuiltin } from "node:module";\nimport { dirname as runtimeDirname, join as runtimeJoin, relative as runtimeRelative, isAbsolute as runtimeIsAbsolute, sep as runtimeSep } from "node:path";\nimport { fileURLToPath as runtimeFilePath, pathToFileURL as runtimeFileUrl } from "node:url";\nconst runtimeLibrary = runtimeFilePath(process.argv[2]);\nlet runtimeRoot = runtimeDirname(runtimeLibrary);\nwhile (runtimeDirname(runtimeRoot) !== runtimeRoot && runtimeRoot.split(runtimeSep).at(-1) !== "node_modules") runtimeRoot = runtimeDirname(runtimeRoot);\nif (runtimeRoot.split(runtimeSep).at(-1) === "node_modules") {\n const runtimeWithin = filename => { const p = runtimeRelative(runtimeRoot, filename); return p === "" || (!runtimeIsAbsolute(p) && p !== ".." && !p.startsWith(".." + runtimeSep)); };\n registerRuntimeHooks({ resolve(specifier, context, nextResolve) {\n  if (runtimeIsBuiltin(specifier)) return nextResolve(specifier, context);\n  const result = nextResolve(specifier, context);\n  if (result.url.startsWith("file:") && runtimeFilePath(result.url).split(runtimeSep).includes("node_modules") && !runtimeWithin(runtimeFilePath(result.url))) { const error = new Error("Dependency is unavailable in the shipped application runtime."); error.code = "MODULE_NOT_FOUND"; throw error; }\n  return result;\n } });\n}\n`;
}
