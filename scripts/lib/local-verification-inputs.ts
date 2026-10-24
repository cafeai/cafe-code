// Fingerprinting is a native no-follow observation, not an Effect filesystem
// substitution: held descriptors, bigint identity and change fences are required.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { constants, type BigIntStats } from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { access, lstat, open, opendir, readlink, realpath } from "node:fs/promises";
// Host-native paths must agree with the actual executor and installed tools.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { createRequire, isBuiltin } from "node:module";
// This fixed metadata lookup owns only its inert xcrun child, with a finite
// output/deadline and exact abort signal; it never launches Git or a provider.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { arch, release, version } from "node:os";
import * as Schema from "effect/Schema";
import ts from "typescript";
import {
  localVerificationGitConfiguration,
  localVerificationGitEnvironmentMatches,
  localVerificationRuntimeEnvironmentSupported,
} from "./local-verification-environment.ts";
import type {
  LocalVerificationFingerprint,
  LocalVerificationInputSnapshot,
  LocalVerificationReceiptStore,
  LocalVerificationTask,
} from "./local-verification-cache-contract.ts";

/** A receipt is prior local evidence, never a hermetic/native/hosted execution
 * claim. These finite limits refuse unusually large or unsupported checkouts;
 * they never truncate an inventory and qualify the truncated result. Native
 * system libraries remain part of the recorded host, not copied application
 * dependencies. A malicious same-UID writer can also replace this observer.
 */
const maximumEntries = 350_000;
const maximumTotalBytes = 16 * 1024 ** 3;
const maximumFileBytes = 512 * 1024 ** 2;
const maximumTextBytes = 4 * 1024 ** 2;
const maximumRetainedTextBytes = 128 * 1024 ** 2;
const sourceExtension = /\.(?:[cm]?[jt]sx?)$/u;
const knownWorkspaces = new Set([
  "apps/server",
  "apps/web",
  "apps/desktop",
  "packages/contracts",
  "packages/shared",
  "packages/client-runtime",
  "packages/effect-acp",
  "packages/effect-codex-app-server",
  "oxlint-plugin-cafecode",
  "scripts",
  "packaging/desktop-runtime",
]);
// These are source-inventory output roles, not installed dependency payloads.
// Use the same names for omission and ancestor-overlap refusal: a compiler or
// source directory alias must not turn a filtered inventory into false proof.
const workspaceSourceOutputs = new Set([
  "dist",
  "build",
  "dist-electron",
  ".vite",
  ".vitest",
  ".turbo",
  "coverage",
]);
function sourceWorkspaceRoot(path: string): string | undefined {
  return /^(apps\/[^/]+|packages\/[^/]+|scripts|oxlint-plugin-cafecode|packaging\/desktop-runtime)(?:\/|$)/u.exec(
    path,
  )?.[1];
}
const json = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);
const executeFile = promisify(execFile);

/** Node's execFile abort/error callback may reject its promisified result before
 * the exact child emits native close. Keep that existing metadata invocation
 * owned through close on every outcome; do not turn a requested signal or a
 * callback error into evidence that the native child has already retired.
 * Synchronous invocation failures propagate without inventing a child owner.
 */
export async function lookupLocalVerificationGitWithXcrun(
  environment: Readonly<Record<string, string | undefined>>,
  signal: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  const lookup = executeFile("/usr/bin/xcrun", ["--find", "git"], {
    env: environment,
    encoding: "utf8",
    shell: false,
    timeout: 5_000,
    killSignal: "SIGKILL",
    maxBuffer: 4_096,
    signal,
  });
  // Install the native-close receipt immediately, before awaiting the result.
  // execFile returns its exact ChildProcess synchronously; native spawn/error
  // and pre-aborted-signal events are delivered after listener registration.
  const closed = new Promise<void>((resolve) => {
    lookup.child.once("close", () => resolve());
  });
  try {
    return await lookup;
  } finally {
    // Preserve the original success/rejection unchanged, but never let a
    // rejected AbortError leave this fixed lookup running behind its caller.
    await closed;
  }
}

class InputRefusal extends Error {
  constructor() {
    super("Local verification inputs could not be qualified");
    this.name = "InputRefusal";
  }
}
function refuse(): never {
  throw new InputRefusal();
}
function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}
function portable(path: string): string {
  return path.split(sep).join("/");
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nativeIdentity(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(
    ":",
  );
}
/** A character device has no ordinary payload: normal /dev/null writes may
 * advance timestamps without replacing it. This is identity encoding only;
 * callers still require the exact root-owned character device, no-follow
 * held/named admission and a final named check. Ordinary files keep their
 * complete byte/change fences through nativeIdentity.
 */
export function localVerificationNullDeviceIdentity(
  stat: Pick<BigIntStats, "dev" | "ino" | "mode" | "nlink" | "uid" | "gid" | "rdev">,
): string {
  return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.uid, stat.gid, stat.rdev].join(":");
}
function feed(hash: ReturnType<typeof createHash>, value: string): void {
  hash.update(`${Buffer.byteLength(value)}:`).update(value);
}
function observationIdentity(stat: BigIntStats): string {
  return stat.isDirectory()
    ? [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid].join(":")
    : nativeIdentity(stat);
}
interface Entry {
  readonly path: string;
  readonly stat: BigIntStats;
  readonly link?: string;
}
interface Content {
  readonly identity: string;
  readonly digest: string;
  readonly text?: string;
}
/** Different task producers select the same native Node/Yarn/OS tools. Retain
 * only sixty-four completed tool digests across those instances, not source
 * text, file handles, environment data or task-success evidence. Every reuse
 * still passes read()'s current native admission and final named change fence.
 * Full native identity includes inode, links, mode, size and change timestamps;
 * a different canonical name or any changed identity requires a byte read.
 */
const maximumRememberedToolDigests = 64;
const rememberedToolDigests = new Map<string, Readonly<Pick<Content, "identity" | "digest">>>();
export type LocalVerificationInputRefusal =
  | "namespace"
  | "workspace"
  | "dependencies"
  | "imports"
  | "tools"
  | "environment"
  | "browser"
  | "changed"
  | "cancelled";
export interface LocalVerificationInputDiagnostic {
  readonly file: string;
  readonly index: number;
  readonly kind:
    | "configuration"
    | "nonliteral-loader"
    | "unresolved-import"
    | "outside-import"
    | "missing-reference";
}

/** Only generated/private namespaces with an existing repository role are
 * omitted. In particular, a directory named `dist` inside ordinary source is
 * NOT silently excluded. Unsupported local environment files cause a miss
 * without opening their contents; credentials are never fingerprint payloads.
 */
function excludedSource(path: string): boolean {
  if (/^(?:\.git|\.plans|\.logs|\.turbo|node_modules|native)(?:\/|$)/u.test(path)) return true;
  // These two repository-root namespaces are generated build/observation
  // outputs. A same-named directory deeper in real source remains an input.
  if (/^(?:build|\.explorations)(?:\/|$)/u.test(path)) return true;
  // The router generator's default temporary-write namespace is relative to
  // the web workspace. Other .tanstack data is not covered by this role.
  if (/^apps\/web\/\.tanstack\/tmp(?:\/|$)/u.test(path)) return true;
  const workspace = sourceWorkspaceRoot(path);
  if (workspace !== undefined) {
    const child = path.slice(workspace.length + 1).split("/", 1)[0];
    if (child === "node_modules" || (child !== undefined && workspaceSourceOutputs.has(child)))
      return true;
  }
  const retirement = /^(.*)\/\.typecheck-retirement-[A-Za-z0-9]{6}(?:\/|$)/u.exec(path);
  if (retirement?.[1] && knownWorkspaces.has(retirement[1])) return true;
  return /(?:^|\/)tsconfig(?:\.[^/]*)?\.tsbuildinfo$/u.test(path);
}
function privateSource(path: string): boolean {
  return (
    /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.netrc|credentials)(?:\/|$)/u.test(path) &&
    !/(?:^|\/)\.env\.(?:example|sample|template)$/u.test(path)
  );
}

export function createLocalVerificationFingerprint(
  repoRoot: string,
  store: LocalVerificationReceiptStore,
  onRefusal?: (
    reason: LocalVerificationInputRefusal,
    detail?: LocalVerificationInputDiagnostic,
    task?: LocalVerificationTask,
  ) => void,
): LocalVerificationFingerprint {
  // Content memoization is process-local and requires the complete native
  // change identity on EVERY observation. Names/inventory are always rescanned.
  const memo = new Map<string, Content>();
  const syntaxMemo = new Map<string, string>();
  let retainedTextBytes = 0;
  return async (task, signal): Promise<LocalVerificationInputSnapshot | undefined> => {
    let phase: LocalVerificationInputRefusal = "namespace";
    let detail: LocalVerificationInputDiagnostic | undefined;
    try {
      const check = () => {
        if (signal.aborted) refuse();
      };
      check();
      // These local-only defaults close Git's implicit user/system data reads.
      // A caller's unsupported hooks/selectors are not dropped or normalized:
      // the original task must execute fresh instead of acquiring a receipt.
      phase = "environment";
      if (!localVerificationRuntimeEnvironmentSupported(task.environment)) refuse();
      const environment = { ...task.environment };
      const serverNode = task.scope.kind === "node" && task.scope.workspace === "apps/server";
      if (serverNode && !localVerificationGitEnvironmentMatches(repoRoot, environment)) refuse();
      phase = "namespace";
      const root = await realpath(repoRoot);
      const diagnose = (
        path: string,
        index: number,
        kind: LocalVerificationInputDiagnostic["kind"],
      ) => {
        if (!inside(root, path)) {
          detail = undefined;
          return;
        }
        const file = portable(relative(root, path));
        detail =
          file.length <= 4096 &&
          Number.isSafeInteger(index) &&
          index >= 0 &&
          index <= maximumTextBytes
            ? { file, index, kind }
            : undefined;
      };
      if (
        resolve(repoRoot) !== root ||
        !inside(root, task.cwd) ||
        (await realpath(task.cwd)) !== task.cwd
      )
        refuse();
      const key = createHash("sha256");
      const fence = createHash("sha256");
      feed(key, "cafecode.local-verification.inputs.v1");
      feed(fence, "cafecode.local-verification.native-fence.v1");
      let entries = 0;
      let bytes = 0;
      let snapshotTextBytes = 0;
      const textInputs = new Set<string>();
      const all = new Map<string, Entry>();
      const manifests = new Map<string, string>();
      const links = new Map<string, string>();
      const selected = new Set<string>();
      const observed = new Map<string, string>();
      let nullDeviceIdentity: string | undefined;
      const memberships = new Map<
        string,
        { kind: "source" | "installed" | "payload"; digest: string }
      >();
      const addObservation = (path: string, stat: BigIntStats) => {
        const identity = observationIdentity(stat);
        const previous = observed.get(path);
        if (previous !== undefined && previous !== identity) refuse();
        observed.set(path, identity);
      };
      const read = async (entry: Entry, text = false, singleLink = true): Promise<Content> => {
        check();
        if (text && !textInputs.has(entry.path)) {
          snapshotTextBytes += Number(entry.stat.size);
          if (snapshotTextBytes > maximumRetainedTextBytes) refuse();
          textInputs.add(entry.path);
        }
        if (
          !entry.stat.isFile() ||
          (singleLink ? entry.stat.nlink !== 1n : entry.stat.nlink < 1n) ||
          entry.stat.size < 0n ||
          entry.stat.size > BigInt(text ? maximumTextBytes : maximumFileBytes)
        )
          refuse();
        const identity = nativeIdentity(entry.stat);
        const cached = memo.get(entry.path);
        if (cached?.identity === identity && (!text || cached.text !== undefined)) {
          const current = await lstat(entry.path, { bigint: true });
          if (!current.isFile() || nativeIdentity(current) !== identity) refuse();
          addObservation(entry.path, current);
          return cached;
        }
        const file = await open(
          entry.path,
          constants.O_RDONLY |
            (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK),
        );
        try {
          const before = await file.stat({ bigint: true });
          if (!before.isFile() || nativeIdentity(before) !== identity) refuse();
          const hash = createHash("sha256");
          const buffer = Buffer.alloc(64 * 1024);
          const chunks: Buffer[] = [];
          let position = 0;
          while (position < Number(before.size)) {
            check();
            const result = await file.read(
              buffer,
              0,
              Math.min(buffer.length, Number(before.size) - position),
              position,
            );
            if (result.bytesRead === 0) refuse();
            const chunk = buffer.subarray(0, result.bytesRead);
            hash.update(chunk);
            if (text) chunks.push(Buffer.from(chunk));
            position += result.bytesRead;
          }
          if ((await file.read(buffer, 0, 1, position)).bytesRead !== 0) refuse();
          const after = await file.stat({ bigint: true });
          const named = await lstat(entry.path, { bigint: true });
          if (
            !named.isFile() ||
            nativeIdentity(after) !== identity ||
            nativeIdentity(named) !== identity
          )
            refuse();
          const content: Content = {
            identity,
            digest: hash.digest("hex"),
            ...(text ? { text: Buffer.concat(chunks).toString("utf8") } : {}),
          };
          if (memo.size >= maximumEntries && !memo.has(entry.path)) {
            memo.clear();
            syntaxMemo.clear();
            retainedTextBytes = 0;
          }
          retainedTextBytes -= Buffer.byteLength(memo.get(entry.path)?.text ?? "");
          const textBytes = Buffer.byteLength(content.text ?? "");
          if (retainedTextBytes + textBytes <= maximumRetainedTextBytes) {
            memo.set(entry.path, content);
            retainedTextBytes += textBytes;
          } else memo.set(entry.path, { identity: content.identity, digest: content.digest });
          addObservation(entry.path, named);
          return content;
        } finally {
          await file.close();
        }
      };
      const boundedNames = async (path: string, maximum: number): Promise<string[]> => {
        const names: string[] = [];
        const directory = await opendir(path);
        // Iterator retirement closes the exact native directory on success,
        // refusal and cancellation; never allocate an unbounded readdir array.
        for await (const entry of directory) {
          check();
          if (names.length >= maximum) refuse();
          names.push(entry.name);
        }
        return names.sort();
      };
      const omittedOutputs = new Set([
        join(root, "build"),
        join(root, ".explorations"),
        join(root, "apps/web/.tanstack/tmp"),
      ]);
      const registerWorkspaceOutputs = (workspace: string) => {
        for (const output of workspaceSourceOutputs) omittedOutputs.add(join(workspace, output));
      };
      // Qualify envelopes even before generated children exist. Native first
      // creation must remain an output change, while broad compiler/ambient
      // scopes that could consume those children are conservatively ineligible.
      for (const workspace of knownWorkspaces) registerWorkspaceOutputs(join(root, workspace));
      const webTestDirectory = join(root, "apps/web/src/components");
      const routerTemporaryContainer = join(root, "apps/web/.tanstack");
      const inOmittedOutput = (path: string): boolean => {
        // Keep Windows' native path-relative case policy. POSIX paths use
        // bounded nearest-ancestor membership, avoiding an output-set scan
        // for every name in the source/dependency inventory.
        if (process.platform === "win32") {
          for (const output of omittedOutputs) if (inside(output, path)) return true;
          return false;
        }
        let current = resolve(path);
        for (let depth = 0; depth <= 256; depth++) {
          if (omittedOutputs.has(current)) return true;
          const parent = dirname(current);
          if (parent === current) return false;
          current = parent;
        }
        return refuse();
      };
      const overlapsOmittedOutput = (path: string): boolean => {
        for (const output of omittedOutputs)
          if (inside(path, output) || inside(output, path)) return true;
        return false;
      };
      const excluded = (path: string, kind: "source" | "installed" | "payload") => {
        const name = portable(relative(root, path));
        // Vitest 5's default workspace-root module cache is derived compiler
        // output, just like Vite's generated cache. Normal transforms can create
        // or rewrite it while another workspace is qualifying. Omit only the
        // installed node_modules namespace: source/dependency-owned lookalikes
        // and custom output locations remain bound. This retains Vitest's
        // existing trusted-local transform reuse, not independent authentication
        // of cached transformed code or a fresh-compilation assertion.
        return kind === "source"
          ? excludedSource(name) || inOmittedOutput(path)
          : kind === "installed" &&
              /(?:^|\/)node_modules\/(?:\.cache|\.vite|\.vite-temp|\.vitest-cache|\.turbo)(?:\/|$)/u.test(
                name,
              );
      };
      const relevantNames = async (
        path: string,
        kind: "source" | "installed" | "payload",
        maximum: number,
      ) => {
        const names = await boundedNames(path, maximum);
        if (kind === "source" && inside(webTestDirectory, path)) {
          // Vitest's default screenshot path is a sibling __screenshots__
          // directory of a real browser test module, not a global basename
          // exclusion. Qualify that source witness without following a link;
          // the ordinary traversal/final fence also observes the module.
          for (const name of names) {
            if (!name.endsWith(".browser.tsx")) continue;
            const module = await lstat(join(path, name), { bigint: true });
            if (module.isFile() && module.nlink === 1n)
              omittedOutputs.add(join(path, "__screenshots__"));
          }
        }
        const relevant: string[] = [];
        for (const name of names) {
          const child = join(path, name);
          if (excluded(child, kind)) continue;
          if (kind === "source" && child === routerTemporaryContainer) {
            // First creation of the otherwise output-only container must not
            // alter an input key/fence. Do not omit a symlink, ordinary file or
            // container holding any non-temporary data. Its parent's repeated
            // membership observations requalify this exact output-only role.
            const before = await lstat(child, { bigint: true });
            if (before.isDirectory()) {
              const children = await boundedNames(child, maximum);
              const after = await lstat(child, { bigint: true });
              if (
                !after.isDirectory() ||
                observationIdentity(before) !== observationIdentity(after)
              )
                refuse();
              if (children.every((entry) => entry === "tmp")) continue;
            }
          }
          relevant.push(name);
        }
        return relevant;
      };
      const membershipDigest = (names: readonly string[]) => {
        const hash = createHash("sha256");
        feed(hash, String(names.length));
        for (const name of names) feed(hash, name);
        return hash.digest("hex");
      };
      const observeTree = async (
        path: string,
        kind: "source" | "installed" | "payload",
        allowedLinkRoots: readonly string[] = [],
      ): Promise<void> => {
        check();
        // Declared output names can disappear during exact owned cleanup;
        // filter them before stat, not after opening a vanished output name.
        if (excluded(path, kind)) return;
        const stat = await lstat(path, { bigint: true });
        if (++entries > maximumEntries) refuse();
        const name = portable(relative(root, path));
        if (kind === "source" && privateSource(name)) refuse();
        if (stat.isSymbolicLink()) {
          const link = await readlink(path);
          const target = await realpath(path);
          if (!allowedLinkRoots.some((admitted) => inside(admitted, target))) refuse();
          const after = await lstat(path, { bigint: true });
          if (nativeIdentity(after) !== nativeIdentity(stat) || (await readlink(path)) !== link)
            refuse();
          all.set(path, { path, stat, link });
          links.set(path, target);
          addObservation(path, stat);
          return; // Target must also have its own independently inventoried name.
        }
        if (stat.isDirectory()) {
          // The original source role also covers workspace-shaped directories
          // without a package manifest. A source alias can read their omitted
          // descendants too; declaration discovery alone is not a complete
          // inventory of this exclusion boundary. Installed traversal never
          // takes this branch and retains every genuine dependency byte.
          if (kind === "source" && sourceWorkspaceRoot(name) === name)
            registerWorkspaceOutputs(path);
          all.set(path, { path, stat });
          const children = await relevantNames(path, kind, maximumEntries - entries);
          const digest = membershipDigest(children);
          for (const child of children)
            await observeTree(join(path, child), kind, allowedLinkRoots);
          const after = await lstat(path, { bigint: true });
          if (
            !after.isDirectory() ||
            observationIdentity(after) !== observationIdentity(stat) ||
            membershipDigest(await relevantNames(path, kind, maximumEntries)) !== digest
          )
            refuse();
          memberships.set(path, { kind, digest });
          addObservation(path, stat);
          return;
        }
        if (
          !stat.isFile() ||
          stat.nlink !== 1n ||
          stat.size < 0n ||
          stat.size > BigInt(maximumFileBytes)
        )
          refuse();
        bytes += Number(stat.size);
        if (bytes > maximumTotalBytes) refuse();
        all.set(path, { path, stat });
      };
      await observeTree(root, "source", [root]);
      if (serverNode) {
        phase = "environment";
        const configuration = all.get(join(root, "scripts/fixtures/local-verification-git.config"));
        const templatePath = join(root, "scripts/fixtures/local-verification-git-template");
        const template = all.get(templatePath);
        const keep = all.get(join(templatePath, ".gitkeep"));
        if (
          !configuration?.stat.isFile() ||
          configuration.link !== undefined ||
          configuration.stat.nlink !== 1n ||
          (await read(configuration, true)).text !== localVerificationGitConfiguration ||
          !template?.stat.isDirectory() ||
          template.link !== undefined ||
          !keep?.stat.isFile() ||
          keep.link !== undefined ||
          keep.stat.nlink !== 1n ||
          (await boundedNames(templatePath, 2)).join(",") !== ".gitkeep"
        )
          refuse();
        // /dev/null is an intentional device, not a private ordinary file. Do
        // not read its bytes or chmod it; prove the exact root-owned native
        // character device through a no-follow held descriptor and named
        // observations. Its rdev is part of identity, not just a path string.
        if (process.platform !== "win32") {
          if ((await realpath("/dev/null")) !== "/dev/null") refuse();
          const named = await lstat("/dev/null", { bigint: true });
          if (!named.isCharacterDevice() || named.uid !== 0n || named.nlink < 1n) refuse();
          nullDeviceIdentity = localVerificationNullDeviceIdentity(named);
          const file = await open(
            "/dev/null",
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          try {
            const held = await file.stat({ bigint: true });
            const current = await lstat("/dev/null", { bigint: true });
            if (
              !held.isCharacterDevice() ||
              !current.isCharacterDevice() ||
              localVerificationNullDeviceIdentity(held) !== nullDeviceIdentity ||
              localVerificationNullDeviceIdentity(current) !== nullDeviceIdentity
            )
              refuse();
          } finally {
            await file.close();
          }
          feed(key, "fixed-git-null-device");
          feed(key, nullDeviceIdentity);
        }
        // Windows retains only metadata/path fixture coverage here. Its normal
        // receipt store and session remain unavailable; this does not attest a
        // Windows equivalent of the POSIX device or grant normal task reuse.
      }
      const rootManifestEntry = all.get(join(root, "package.json"));
      if (!rootManifestEntry) refuse();
      const rootManifest = json((await read(rootManifestEntry, true)).text ?? "");
      phase = "workspace";
      if (
        !object(rootManifest) ||
        rootManifest.packageManager !== "yarn@4.17.1" ||
        !Array.isArray(rootManifest.workspaces)
      )
        refuse();
      const workspaces = new Map<string, string>();
      for (const pattern of rootManifest.workspaces) {
        if (
          typeof pattern !== "string" ||
          !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*(?:\/\*)?$/u.test(pattern)
        )
          refuse();
        const candidates = pattern.endsWith("/*")
          ? [...all.keys()]
              .filter(
                (path) =>
                  dirname(path) === join(root, pattern.slice(0, -2)) &&
                  all.get(path)?.stat.isDirectory(),
              )
              .map((path) => portable(relative(root, path)))
          : [pattern];
        for (const location of candidates) {
          const entry = all.get(join(root, location, "package.json"));
          if (!entry) continue;
          const value = json((await read(entry, true)).text ?? "");
          if (
            !object(value) ||
            typeof value.name !== "string" ||
            workspaces.has(value.name) ||
            !knownWorkspaces.has(location)
          )
            refuse();
          workspaces.set(value.name, location);
        }
      }
      const workspacePaths = [...workspaces.values()].map((path) => join(root, path));
      const installedRoots = [
        join(root, "node_modules"),
        ...workspacePaths.map((path) => join(path, "node_modules")),
      ];
      const absentInstalledRoots: string[] = [];
      const isInstalled = (path: string) =>
        installedRoots.some((installed) => inside(installed, path));
      phase = "dependencies";
      for (const installed of installedRoots) {
        try {
          await lstat(installed, { bigint: true });
        } catch (error) {
          if (!Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }))(error)) refuse();
          absentInstalledRoots.push(installed);
          continue;
        }
        await observeTree(installed, "installed", [...installedRoots, ...workspacePaths]);
      }
      // All installed payload bytes are inputs, including Electron dist and
      // patched compiler/adapter bytes. Workspace aliases are recorded without
      // recursively importing every unrelated workspace's tests into the key.
      for (const [path, entry] of all) {
        if (isInstalled(path)) selected.add(path);
        if (entry.stat.isFile() && basename(path) === "package.json") {
          manifests.set(path, (await read(entry, true)).text ?? "");
        }
      }
      const addedTrees = new Set<string>();
      const addTree = (path: string) => {
        if (addedTrees.has(path)) return;
        addedTrees.add(path);
        for (const name of all.keys()) if (inside(path, name)) selected.add(name);
      };
      const addFile = (path: string) => {
        if (all.has(path)) selected.add(path);
        else refuse();
      };
      // These are common task producers/configuration, not a declaration that
      // arbitrary repo-wide reads are absent. The scripts workspace explicitly
      // owns repository policy tests and therefore uses the complete inventory.
      for (const path of all.keys()) {
        const name = portable(relative(root, path));
        if (
          !name.includes("/") ||
          name.startsWith(".yarn/") ||
          name.startsWith(".github/") ||
          name.startsWith("scripts/") ||
          name.startsWith("packages/")
        )
          selected.add(path);
      }
      let workspace: string;
      if (task.scope.kind === "browser") {
        workspace = "apps/web";
        if (
          task.cwd !== root ||
          task.scope.files.length === 0 ||
          task.scope.projects.length === 0 ||
          task.scope.files.some(
            (path) => !inside(join(root, workspace), resolve(root, workspace, path)),
          )
        )
          refuse();
        for (const file of task.scope.files) addFile(resolve(root, workspace, file));
      } else {
        workspace = task.scope.workspace;
        if (!knownWorkspaces.has(workspace) || ![...workspaces.values()].includes(workspace))
          refuse();
        if (task.cwd !== (task.scope.kind === "node" ? root : join(root, workspace))) refuse();
      }
      addTree(join(root, workspace));
      if (workspace === "scripts") for (const path of all.keys()) selected.add(path);
      // Reviewed data reads, distinct from JS imports: shared font policy reads
      // web CSS; server packaging/test-plan policy reads the web group contract.
      for (const data of ["apps/web/src/index.css", "apps/web/browser-test-policy.json"])
        addFile(join(root, data));
      // Root-level web build configuration is imported by scripts tsconfig and
      // affects browser transforms. Unrelated browser fixture bodies do not.
      for (const path of all.keys())
        if (dirname(path) === join(root, "apps/web") && /\.(?:json|[cm]?ts)$/u.test(path))
          selected.add(path);

      const aliases = [...links].sort(([a], [b]) => b.length - a.length);
      const actual = (path: string): string => {
        // On POSIX the longest matching alias is exactly the nearest native
        // ancestor. Avoid scanning every installed .bin alias per resolver
        // query. Preserve the old single substitution and Windows' existing
        // case-insensitive path-relative behavior, not a new casing policy.
        if (process.platform === "win32") {
          for (const [alias, target] of aliases)
            if (inside(alias, path)) return join(target, relative(alias, path));
          return path;
        }
        let current = resolve(path);
        for (let depth = 0; depth <= 256; depth++) {
          const target = links.get(current);
          if (target !== undefined) return join(target, relative(current, path));
          const parent = dirname(current);
          if (parent === current) return path;
          current = parent;
        }
        return refuse();
      };
      const host: ts.ModuleResolutionHost = {
        fileExists: (path) => all.get(actual(resolve(path)))?.stat.isFile() ?? false,
        readFile: (path) => manifests.get(actual(resolve(path))),
        directoryExists: (path) => all.get(actual(resolve(path)))?.stat.isDirectory() ?? false,
        realpath: (path) => actual(resolve(path)),
        getCurrentDirectory: () => root,
      };
      const options: ts.CompilerOptions = {
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        allowJs: true,
        resolveJsonModule: true,
      };
      const configSeen = new Set<string>();
      const programRoots = new Set<string>();
      // ParseConfigHost delegates glob discovery to the host. Use the already
      // bounded inventory, not an extra native traversal which could escape
      // into a newly introduced symlink or private directory. Only ordinary TS
      // glob syntax is supported; a future bracket/brace extension is a miss.
      const matchGlob = (base: string, pattern: string, path: string): boolean => {
        if (/[\u0000\[\]{}!]/u.test(pattern)) refuse();
        const absolute = portable(resolve(base, pattern));
        const literal = resolve(base, pattern);
        if (!/[?*]/u.test(pattern)) return path === literal || inside(literal, path);
        const segments = absolute.split("/");
        let expression = "^";
        for (let index = 0; index < segments.length; index++) {
          const segment = segments[index] ?? "";
          if (segment === "**") expression += index === segments.length - 1 ? ".*" : "(?:[^/]+/)*";
          else {
            for (const character of segment)
              expression +=
                character === "*"
                  ? "[^/]*"
                  : character === "?"
                    ? "[^/]"
                    : character.replace(/[\\^$+?.()|]/gu, "\\$&");
            if (index !== segments.length - 1) expression += "/";
          }
        }
        return new RegExp(`${expression}$`, ts.sys.useCaseSensitiveFileNames ? "u" : "iu").test(
          portable(path),
        );
      };
      const readDirectory: ts.ParseConfigHost["readDirectory"] = (
        base,
        extensions,
        excludes,
        includes,
      ) => {
        if (!inside(root, resolve(base))) refuse();
        const files: string[] = [];
        for (const [path, entry] of all) {
          if (
            !entry.stat.isFile() ||
            !inside(root, path) ||
            isInstalled(path) ||
            excluded(path, "source")
          )
            continue;
          if (extensions && !extensions.some((extension) => path.endsWith(extension))) continue;
          if (
            !(includes ?? ["**/*"]).some((pattern) => matchGlob(base, pattern, path)) ||
            (excludes ?? []).some((pattern) => matchGlob(base, pattern, path))
          )
            continue;
          files.push(path);
        }
        return files;
      };
      const config = async (path: string, collect = false): Promise<void> => {
        path = resolve(path);
        diagnose(path, 0, "configuration");
        if (configSeen.has(path)) return;
        configSeen.add(path);
        const entry = all.get(path);
        if (!entry || !inside(root, path)) refuse();
        selected.add(path);
        const parsed = ts.parseConfigFileTextToJson(path, (await read(entry, true)).text ?? "");
        if (parsed.error || !object(parsed.config)) refuse();
        const value: Record<string, unknown> = parsed.config;
        if (value.extends !== undefined) {
          const parents = Array.isArray(value.extends) ? value.extends : [value.extends];
          for (const parent of parents) {
            if (typeof parent !== "string" || !parent.startsWith(".")) refuse();
            const candidate = resolve(dirname(path), parent);
            await config(candidate.endsWith(".json") ? candidate : `${candidate}.json`);
          }
        }
        // The public config parser supplies relative `paths`' config-file base
        // even when no baseUrl is declared. Merely converting compilerOptions
        // would incorrectly resolve ~/... from the coordinator's cwd.
        const parsedOptions = ts.parseJsonConfigFileContent(
          value,
          {
            useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
            fileExists: host.fileExists,
            readFile: (name) => memo.get(actual(resolve(name)))?.text,
            readDirectory,
          },
          dirname(path),
          undefined,
          path,
        );
        if (parsedOptions.errors.some((error) => error.code !== 18002 && error.code !== 18003))
          refuse();
        Object.assign(options, parsedOptions.options);
        if (collect && task.scope.kind === "typecheck") {
          // TypeScript supplies effective wildcard roots after resolving
          // inherited/default includes. An omitted output below OR above one
          // of those envelopes could contain a real compiler input even when
          // presently absent. Refuse rather than parse a silently shrunken
          // program. Extends-only defaults are not an actual child program.
          for (const wildcard of Object.keys(parsedOptions.wildcardDirectories ?? {})) {
            const target = resolve(wildcard);
            if (!inside(root, target) || overlapsOmittedOutput(target)) refuse();
          }
          for (const file of parsedOptions.fileNames) {
            const target = actual(resolve(file));
            addFile(target);
            if (sourceExtension.test(target)) programRoots.add(target);
          }
          // Explicit ambient roots need not be imported by any program file.
          // Admit only real directories already present in this bounded source
          // or installed inventory; never traverse a user/global types path.
          for (const typeRoot of parsedOptions.options.typeRoots ?? []) {
            const target = actual(resolve(typeRoot));
            const directory = all.get(target);
            if (
              !inside(root, target) ||
              !directory?.stat.isDirectory() ||
              (!isInstalled(target) &&
                (excluded(target, "source") || overlapsOmittedOutput(target)))
            )
              refuse();
            addTree(target);
            for (const [file, ambient] of all)
              if (inside(target, file) && ambient.stat.isFile() && sourceExtension.test(file))
                programRoots.add(file);
          }
        }
        if (task.scope.kind === "typecheck") {
          for (const field of ["include", "files"]) {
            const patterns: unknown = value[field];
            if (patterns === undefined) continue;
            if (!Array.isArray(patterns)) refuse();
            for (const pattern of patterns) {
              if (typeof pattern !== "string") refuse();
              const prefix = pattern.split(/[?*]/u, 1)[0] ?? "";
              const target = resolve(dirname(path), prefix);
              if (!inside(root, target) || excluded(target, "source")) refuse();
              const exact = all.get(target);
              if (exact?.stat.isFile()) selected.add(target);
              else addTree(exact?.stat.isDirectory() ? target : dirname(target));
            }
          }
          if (value.references !== undefined) {
            if (!Array.isArray(value.references)) refuse();
            for (const reference of value.references) {
              if (!object(reference) || typeof reference.path !== "string") refuse();
              const target = resolve(dirname(path), reference.path);
              await config(target.endsWith(".json") ? target : join(target, "tsconfig.json"), true);
            }
          }
        }
      };
      phase = "imports";
      await config(join(root, workspace, "tsconfig.json"), true);
      if (task.scope.kind === "typecheck") {
        if (
          options.configFilePath !== undefined &&
          // TypeScript spells Windows paths with forward slashes. Compare
          // native absolute paths without rewriting POSIX backslashes or
          // admitting an unexpected relative result through the process cwd.
          (typeof options.configFilePath !== "string" ||
            !isAbsolute(options.configFilePath) ||
            resolve(options.configFilePath) !== join(root, workspace, "tsconfig.json"))
        )
          refuse();
        if (
          options.tsBuildInfoFile !== undefined &&
          resolve(options.tsBuildInfoFile) !== join(root, workspace, "tsconfig.tsbuildinfo")
        )
          refuse();
      }
      // Parse real import syntax rather than infer a closure from package.json
      // devDependencies. The server's web build dependency does not imply its
      // Node tests consume all browser fixtures. New cross-root imports become
      // actual inputs; nonliteral dynamic import/require calls are a safe miss.
      phase = "imports";
      // Inventoried data is deliberately broader than executable roots. Only
      // the server's existing explicit integration E2E exclusion is special;
      // other ordinary configs may collect opt-in .test/.spec modules even
      // when their individual cases are skipped. Unsupported runtime loaders
      // in those modules remain conservative misses. Browser roots are the
      // actual selected group; types use the real parsed static program roots.
      const queue =
        task.scope.kind === "browser"
          ? task.scope.files.map((path) => resolve(root, workspace, path))
          : task.scope.kind === "typecheck"
            ? [...programRoots]
            : [...selected].filter(
                (path) =>
                  inside(join(root, workspace), path) &&
                  !isInstalled(path) &&
                  sourceExtension.test(path) &&
                  /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path) &&
                  !(
                    workspace === "apps/server" &&
                    inside(join(root, workspace, "integration"), path) &&
                    /\.e2e\.test\.ts$/u.test(path)
                  ),
              );
      const visited = new Set<string>();
      const runtimeChecked = new Set<string>();
      const admitStaticAsset = (name: string, importer: string): boolean => {
        const parts = name.split("?");
        if (parts.length > 2) return false;
        const file = parts[0];
        const query = parts[1];
        if (!file || (query !== undefined && !/^(?:inline|url|raw)$/u.test(query))) return false;
        // JavaScript is an opaque asset ONLY with Vite's exact raw modifier
        // (the Mermaid engine is one actual consumer), never a substitute JS
        // module-resolution policy. Other listed formats are static payloads.
        if (
          !/\.(?:woff2?|ttf|otf|eot|svg|png|jpe?g|gif|webp|avif|ico|css|txt|html|json|wasm)$/iu.test(
            file,
          ) &&
          !(query === "raw" && /\.[cm]?js$/iu.test(file))
        )
          return false;
        if (/[\\\u0000%#]/u.test(file)) return false;
        if (file.startsWith(".")) {
          const target = actual(resolve(dirname(importer), file));
          if (!inside(root, target) || !all.get(target)?.stat.isFile()) return false;
          addFile(target);
          return true;
        }
        const segments = file.split("/");
        const packageLength = file.startsWith("@") ? 2 : 1;
        if (
          segments.length <= packageLength ||
          segments.some(
            (segment, index) =>
              !/^[A-Za-z0-9_.-]+$/u.test(
                index === 0 && packageLength === 2 ? segment.slice(1) : segment,
              ) ||
              segment === "." ||
              segment === "..",
          )
        )
          return false;
        const packageName = segments.slice(0, packageLength).join("/");
        let current = dirname(importer);
        for (let depth = 0; depth <= 256; depth++) {
          if (!inside(root, current)) return false;
          const packageRoot = actual(join(current, "node_modules", packageName));
          const directory = all.get(packageRoot);
          if (directory) {
            // Once the nearest package exists, a missing/escaping asset cannot
            // silently fall through to a different hoisted package version.
            if (
              !directory.stat.isDirectory() ||
              !isInstalled(packageRoot) ||
              !manifests.has(join(packageRoot, "package.json"))
            )
              return false;
            const target = actual(resolve(packageRoot, ...segments.slice(packageLength)));
            if (
              !inside(packageRoot, target) ||
              !isInstalled(target) ||
              !all.get(target)?.stat.isFile()
            )
              return false;
            addFile(target);
            return true;
          }
          const parent = dirname(current);
          if (parent === current) return false;
          current = parent;
        }
        return false;
      };
      for (let cursor = 0; cursor < queue.length; cursor++) {
        check();
        const path = queue[cursor];
        if (!path || visited.has(path)) continue;
        visited.add(path);
        const entry = all.get(path);
        if (!entry?.stat.isFile()) refuse();
        const source = (await read(entry, true)).text ?? "";
        diagnose(path, 0, "unresolved-import");
        const syntaxIdentity = nativeIdentity(entry.stat);
        if (task.scope.kind !== "typecheck" && syntaxMemo.get(path) !== syntaxIdentity) {
          const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false);
          const loaders = new Set(["require"]);
          const visit = (node: ts.Node): void => {
            if (
              ts.isVariableDeclaration(node) &&
              ts.isIdentifier(node.name) &&
              node.initializer &&
              ts.isCallExpression(node.initializer) &&
              ts.isIdentifier(node.initializer.expression) &&
              node.initializer.expression.text === "createRequire"
            )
              loaders.add(node.name.text);
            if (
              ts.isCallExpression(node) &&
              (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                (ts.isIdentifier(node.expression) && loaders.has(node.expression.text)))
            ) {
              const argument = node.arguments[0];
              if (node.arguments.length !== 1 || !argument || !ts.isStringLiteralLike(argument)) {
                diagnose(path, node.pos, "nonliteral-loader");
                refuse();
              }
            }
            ts.forEachChild(node, visit);
          };
          visit(ast);
          if (syntaxMemo.size >= maximumEntries) syntaxMemo.clear();
          syntaxMemo.set(path, syntaxIdentity);
        }
        const info = ts.preProcessFile(source, true, true);
        if (info.referencedFiles.length) {
          for (const reference of info.referencedFiles) {
            diagnose(path, reference.pos, "missing-reference");
            const target = resolve(dirname(path), reference.fileName);
            addFile(target);
            queue.push(target);
          }
        }
        for (const imported of info.importedFiles) {
          diagnose(path, imported.pos, "unresolved-import");
          const name = imported.fileName;
          if (name.startsWith("node:")) continue;
          const resolved = ts.resolveModuleName(name, path, options, host).resolvedModule;
          if (!resolved) {
            // Static Vite payloads are resolved only from this existing native
            // inventory, including scoped installed font files. No live/global
            // Node resolver, package execution or export-engine fallback runs.
            if (admitStaticAsset(name, path)) continue;
            // Builtins may be written without node:; TypeScript does not
            // resolve these to a source file. Their exact implementation is
            // already bound by the Node executable, not an external package.
            if (isBuiltin(name)) continue;
            refuse();
          }
          // Resolver results use TypeScript's portable separators, whereas
          // the bounded native inventory and alias names use host paths. A
          // relative result is not evidence of an inventoried absolute input.
          if (!isAbsolute(resolved.resolvedFileName)) {
            diagnose(path, imported.pos, "outside-import");
            refuse();
          }
          const target = actual(resolve(resolved.resolvedFileName));
          if (!inside(root, target) || !all.has(target)) {
            diagnose(path, imported.pos, "outside-import");
            refuse();
          }
          if (!isInstalled(target)) {
            // TypeScript may choose a declaration while native execution
            // chooses this workspace's different JS/default export or assets.
            // Bind the actual imported workspace, not only the type resolver's
            // leaf. Unimported dev/build-only workspaces remain independent.
            const importedWorkspace = workspacePaths.find((path) => inside(path, target));
            if (importedWorkspace) {
              if (task.scope.kind !== "typecheck" && !runtimeChecked.has(importedWorkspace)) {
                runtimeChecked.add(importedWorkspace);
                const manifest = json(manifests.get(join(importedWorkspace, "package.json")) ?? "");
                if (!object(manifest)) refuse();
                let nodes = 0;
                const admitExport = (value: unknown, depth: number, relativeLeaf = false): void => {
                  if (++nodes > 1024 || depth > 16) refuse();
                  // A wildcard before a stable source prefix could select an
                  // excluded runtime tree (./*/runtime.js -> ./dist/...). No
                  // wildcard runtime-export proof is currently qualified.
                  if (typeof value === "string" && value.includes("*")) refuse();
                  if (typeof value === "string" && (relativeLeaf || value.startsWith("."))) {
                    const destination = resolve(importedWorkspace, value);
                    if (!inside(importedWorkspace, destination) || excluded(destination, "source"))
                      refuse();
                  } else if (Array.isArray(value))
                    for (const item of value) admitExport(item, depth + 1, relativeLeaf);
                  else if (object(value))
                    for (const item of Object.values(value)) admitExport(item, depth + 1);
                };
                admitExport(manifest.exports, 0);
                admitExport(manifest.main, 0, true);
                admitExport(manifest.module, 0, true);
                admitExport(manifest.browser, 0, typeof manifest.browser === "string");
              }
              addTree(importedWorkspace);
            }
            selected.add(target);
            if (sourceExtension.test(target)) queue.push(target);
          }
        }
      }
      if (task.scope.kind === "typecheck") {
        const compiler = await realpath(task.scope.compiler);
        if (!inside(join(root, "node_modules/typescript"), compiler)) refuse();
        addFile(compiler);
      }
      // Bind the running executable and actual Yarn/Corepack program bytes,
      // not just reported versions or a lockfile. No arbitrary home traversal.
      // Keep native admission separate from the semantic key until the complete
      // Yarn forwarding directories have been qualified below. Their random
      // names are not executable identity, but no unqualified path may acquire
      // that interchangeability merely by resolving to a qualified entry.
      const tools: {
        requested: string;
        canonical: string;
        digest: string;
        mode: string;
      }[] = [];
      const observeTool = async (path: string): Promise<void> => {
        if (!isAbsolute(path)) refuse();
        const canonical = await realpath(path);
        const stat = await lstat(canonical, { bigint: true });
        const entry = { path: canonical, stat };
        const remembered = rememberedToolDigests.get(canonical);
        if (
          !memo.has(canonical) &&
          memo.size < maximumEntries &&
          remembered?.identity === nativeIdentity(stat)
        ) {
          // Never replace this producer's existing Content: it may hold text
          // charged against retainedTextBytes. Seed only a fresh digest record
          // and let the unchanged read() gates re-observe the actual name.
          memo.set(canonical, { identity: remembered.identity, digest: remembered.digest });
        }
        // Native OS executables can legitimately be hard-linked (macOS Git
        // dispatchers are an example). This is read-only byte observation, not
        // permission to mutate/delete a supposedly exclusive native resource.
        // Held/named identity, nlink and all change metadata still must agree.
        const content = await read(entry, false, false);
        if (
          !rememberedToolDigests.has(canonical) &&
          rememberedToolDigests.size === maximumRememberedToolDigests
        ) {
          const oldest = rememberedToolDigests.keys().next().value;
          if (oldest !== undefined) rememberedToolDigests.delete(oldest);
        }
        // A validated tool byte read may remain useful if an unrelated later
        // input refuses the snapshot. This cannot publish/reuse a task result:
        // all source, selection, environment and native fences still run.
        rememberedToolDigests.set(
          canonical,
          Object.freeze({ identity: content.identity, digest: content.digest }),
        );
        tools.push({
          requested: path,
          canonical,
          digest: content.digest,
          mode: stat.mode.toString(),
        });
      };
      phase = "tools";
      await observeTool(process.execPath);
      if (
        environment.NODE_PATH ||
        environment.LD_PRELOAD ||
        environment.DYLD_INSERT_LIBRARIES ||
        (environment.NODE_OPTIONS && !/^--max-old-space-size=4096$/u.test(environment.NODE_OPTIONS))
      )
        refuse();
      if (!environment.npm_execpath || !environment.COREPACK_ROOT) refuse();
      await observeTool(environment.npm_execpath);
      const corepackRoot = await realpath(environment.COREPACK_ROOT);
      await observeTree(corepackRoot, "payload", [corepackRoot]);
      for (const path of all.keys()) if (inside(corepackRoot, path)) selected.add(path);
      // PATH executable identities are bounded native files. This does not
      // pretend OS dynamic libraries or mutable external credentials are an
      // application dependency closure; host identity is included below.
      for (const tool of process.platform === "win32"
        ? ["git.exe", "cmd.exe", "powershell.exe"]
        : ["git", "sh", "tar", "unzip", "mkfifo", "sleep", "cat"]) {
        let found = false;
        for (const component of (environment.PATH ?? "").split(delimiter)) {
          if (!component || !isAbsolute(component)) refuse();
          const candidate = join(component, tool);
          let stat: BigIntStats;
          try {
            stat = await lstat(candidate, { bigint: true });
          } catch (error) {
            if (Schema.is(Schema.Struct({ code: Schema.Literals(["ENOENT", "ENOTDIR"]) }))(error))
              continue;
            // EPERM/EACCES/unknown native observation is not proof that native
            // execution would skip this candidate and choose a later binary.
            refuse();
          }
          if (!stat.isFile() && !stat.isSymbolicLink()) refuse();
          const executable = await lstat(await realpath(candidate), { bigint: true });
          if (
            !executable.isFile() ||
            (process.platform !== "win32" && (executable.mode & 0o111n) === 0n)
          )
            refuse();
          if (process.platform !== "win32") await access(candidate, constants.X_OK);
          await observeTool(candidate);
          found = true;
          break;
        }
        if (!found) refuse();
      }
      if (process.platform === "darwin") {
        // /usr/bin/git is a developer-tool shim, not the selected Git payload.
        // Bind its exact selection and authoritative xcrun result as well. An
        // unsupported/missing developer installation is a fresh-task fallback.
        const selection = "/var/db/xcode_select_link";
        const link = await lstat(selection, { bigint: true });
        if (!link.isSymbolicLink() || link.uid !== 0n) refuse();
        addObservation(selection, link);
        feed(key, selection);
        feed(key, await readlink(selection));
        const requested = environment.DEVELOPER_DIR ?? (await realpath(selection));
        if (!isAbsolute(requested)) refuse();
        const developer = await realpath(
          requested.endsWith(".app") ? join(requested, "Contents/Developer") : requested,
        );
        await observeTool("/usr/bin/xcrun");
        const found = await lookupLocalVerificationGitWithXcrun(environment, signal);
        const git = found.stdout.trim();
        if (!isAbsolute(git) || !inside(developer, await realpath(git))) refuse();
        feed(key, developer);
        await observeTool(git);
      }
      phase = "environment";
      // A Yarn temporary wrapper path is interchangeable ONLY when every shim
      // byte and mode is identical in a qualified private ordinary directory.
      // All other environment values (including all other PATH components) are
      // preserved and authenticated; no credentials are returned or logged.
      const wrapperEntries = new Map<string, ReadonlySet<string>>();
      const qualifyWrapper = async (wrapper: string): Promise<string> => {
        if (
          !isAbsolute(wrapper) ||
          (await realpath(wrapper)) !== wrapper ||
          !/^xfs-[a-fA-F0-9]{8}$/u.test(basename(wrapper))
        )
          refuse();
        const stat = await lstat(wrapper, { bigint: true });
        if (
          !stat.isDirectory() ||
          process.platform === "win32" ||
          stat.uid !== BigInt(process.getuid?.() ?? -1) ||
          (stat.mode & 0o022n) !== 0n
        )
          refuse();
        // This is read-only observation of generated public tool forwarding,
        // not a credential or receipt namespace: owner0755 is legitimate.
        // Other-user WRITE is refused; no chmod or mutation is performed. The
        // separate authenticated receipt store still requires private0700.
        const names = await boundedNames(wrapper, 256);
        if (names.length === 0 || names.length > 256) refuse();
        const hash = createHash("sha256");
        let total = 0;
        for (const name of names) {
          const path = join(wrapper, name);
          const item = await lstat(path, { bigint: true });
          if (
            !item.isFile() ||
            item.uid !== stat.uid ||
            (item.mode & 0o022n) !== 0n ||
            item.size > 256n * 1024n
          )
            refuse();
          total += Number(item.size);
          if (total > maximumTextBytes) refuse();
          const content = await read({ path, stat: item }, true);
          // Pinned Yarn's POSIX producer forwards to one absolute executable,
          // literal arguments and the unchanged "$@". No $0/dirname/cwd/state
          // dependent scripts can acquire path-interchangeability authority.
          if (
            !/^#!\/bin\/sh\nexec "\/[^"$`\\\n]+" +(?:(?:'[^'\n]*'|"[^"$`\\\n]*") +)*"\$@"\n$/u.test(
              content.text ?? "",
            )
          )
            refuse();
          const literals = [...(content.text ?? "").matchAll(/"([^"\n]*)"|'([^'\n]*)'/gu)].map(
            (match) => match[1] ?? match[2] ?? "",
          );
          const executable = literals.shift();
          if (!executable || (await realpath(executable)) !== (await realpath(process.execPath)))
            refuse();
          for (const argument of literals) {
            if (argument === "$@" || !isAbsolute(argument)) continue;
            const payload = await realpath(argument);
            if (!isInstalled(payload) && !inside(corepackRoot, payload)) refuse();
            // Installed/Corepack payloads are already complete byte inventories,
            // not only version labels or absolute strings in the shim text.
            const item = all.get(payload);
            if (!item?.stat.isFile()) refuse();
            selected.add(payload);
          }
          feed(hash, name);
          feed(hash, item.mode.toString());
          feed(hash, content.digest);
        }
        const after = await lstat(wrapper, { bigint: true });
        if (
          observationIdentity(after) !== observationIdentity(stat) ||
          membershipDigest(await boundedNames(wrapper, 256)) !== membershipDigest(names)
        )
          refuse();
        memberships.set(wrapper, { kind: "payload", digest: membershipDigest(names) });
        addObservation(wrapper, stat);
        wrapperEntries.set(wrapper, new Set(names));
        const identity = `cafecode:yarn-shims:sha256:${hash.digest("hex")}`;
        return identity;
      };
      const wrapperIdentities = new Map<string, string>();
      if (environment.BERRY_BIN_FOLDER !== undefined) {
        const wrapper = environment.BERRY_BIN_FOLDER;
        wrapperIdentities.set(wrapper, await qualifyWrapper(wrapper));
        environment.BERRY_BIN_FOLDER = wrapperIdentities.get(wrapper);
      }
      if (environment.PATH !== undefined) {
        const components: string[] = [];
        for (const component of environment.PATH.split(delimiter)) {
          let identity = wrapperIdentities.get(component);
          if (!identity && /^xfs-[a-fA-F0-9]{8}$/u.test(basename(component))) {
            // An unqualified PATH directory keeps its literal identity. It is
            // never silently ignored because its name resembles a Yarn shim.
            try {
              identity = await qualifyWrapper(component);
            } catch (error) {
              if (signal.aborted) throw error;
            }
            if (identity) wrapperIdentities.set(component, identity);
          }
          components.push(identity ?? component);
        }
        environment.PATH = components.join(delimiter);
      }
      const qualifiedEntryIdentity = (path: string): string | undefined => {
        const parent = dirname(path);
        const entry = basename(path);
        const identity = wrapperIdentities.get(parent);
        // Admission proved each exact entry ordinary, single-link and bound to
        // the current Node/Corepack/installed payloads. Do not canonicalize an
        // arbitrary alias here: its raw pathname must remain an environment
        // input, rather than borrowing its target's forwarding authority.
        return identity && path === join(parent, entry) && wrapperEntries.get(parent)?.has(entry)
          ? `${identity}:entry:${entry}`
          : undefined;
      };
      for (const [name, entry] of [
        ["npm_execpath", "yarn"],
        ["npm_node_execpath", "node"],
      ] as const) {
        const path = environment[name];
        if (path !== undefined && basename(path) === entry) {
          const identity = qualifiedEntryIdentity(path);
          if (identity) environment[name] = identity;
        }
      }
      // Actual native paths/change metadata remain in this invocation's fence.
      // Only an exact qualified entry gets a stable content identity in the
      // reusable key. Entry names stay distinct even within the same directory;
      // every other tool keeps its original canonical path and byte identity.
      for (const tool of tools) {
        feed(
          key,
          (tool.requested === tool.canonical
            ? qualifiedEntryIdentity(tool.requested)
            : undefined) ?? tool.canonical,
        );
        feed(key, tool.digest);
        feed(key, tool.mode);
      }
      if (task.scope.kind === "browser") {
        phase = "browser";
        // Public executablePath is an inert registry lookup, never a launch.
        // Both full Chromium and its same-revision headless payload are bound:
        // Playwright may choose either according to the actual project options.
        for (const name of ["PLAYWRIGHT_BROWSERS_PATH", "PLAYWRIGHT_HOST_PLATFORM_OVERRIDE"])
          if (environment[name] !== process.env[name]) refuse();
        const require = createRequire(join(root, "package.json"));
        const playwright: unknown = require("playwright-core");
        if (
          !object(playwright) ||
          !object(playwright.chromium) ||
          typeof playwright.chromium.executablePath !== "function"
        )
          refuse();
        const executable: unknown = playwright.chromium.executablePath();
        if (typeof executable !== "string") refuse();
        const chromium = /^(.*)[\\/]chromium-(\d+)[\\/]/u.exec(executable);
        if (!chromium?.[1] || !chromium[2]) refuse();
        const payloads = [
          join(chromium[1], `chromium-${chromium[2]}`),
          join(chromium[1], `chromium_headless_shell-${chromium[2]}`),
        ];
        for (const payload of payloads) {
          if ((await realpath(payload)) !== payload) refuse();
          await observeTree(payload, "payload", [payload]);
          for (const path of all.keys()) if (inside(payload, path)) selected.add(path);
        }
      }
      feed(key, root);
      feed(key, task.cwd);
      feed(key, task.id);
      feed(key, `arguments:${task.args.length}`);
      for (const argument of task.args) feed(key, argument);
      feed(key, task.scope.kind);
      if (task.scope.kind === "browser") {
        feed(key, `files:${task.scope.files.length}`);
        for (const file of task.scope.files) feed(key, file);
        feed(key, `projects:${task.scope.projects.length}`);
        for (const project of task.scope.projects) feed(key, project);
      } else {
        feed(key, task.scope.workspace);
        if (task.scope.kind === "typecheck") feed(key, task.scope.compiler);
      }
      const authenticated = store.authenticateEnvironment(environment);
      if (!authenticated || authenticated.length > 4096) refuse();
      feed(key, authenticated);
      for (const value of [
        process.version,
        process.platform,
        arch(),
        release(),
        version(),
        ...Object.entries(process.versions).sort().flat(),
      ]) {
        if (typeof value !== "string") refuse();
        feed(key, value);
      }
      // Source links are data inputs as well as module aliases. Bind their
      // admitted target bytes even when no static import mentions them. Never
      // follow a link into an intentionally excluded private/output namespace.
      // Installed workspace aliases remain inert until an actual source import
      // selects that workspace; hashing every unused alias would defeat task
      // independence without proving any additional executed dependency.
      const sourceLinks = [...selected].filter(
        (path) => all.get(path)?.link !== undefined && !isInstalled(path),
      );
      const admittedLinks = new Set(sourceLinks);
      for (let index = 0; index < sourceLinks.length; index++) {
        const path = sourceLinks[index];
        if (!path) continue;
        const entry = all.get(path);
        if (entry?.link === undefined || isInstalled(path)) continue;
        const target = links.get(path);
        if (!target || !all.has(target)) refuse();
        if (!isInstalled(path)) {
          const before = selected.size;
          const targetEntry = all.get(target);
          if (targetEntry?.stat.isDirectory()) {
            // This ordinary source link grants a directory data-read surface,
            // not merely module resolution. A filtered subtree is incomplete
            // if reachable descendants have an omitted output role. Installed
            // workspace aliases retain their separate inert import policy.
            if (overlapsOmittedOutput(target)) refuse();
            addTree(target);
          } else selected.add(target);
          if (selected.size !== before)
            for (const added of selected)
              if (
                all.get(added)?.link !== undefined &&
                !isInstalled(added) &&
                !admittedLinks.has(added)
              ) {
                admittedLinks.add(added);
                sourceLinks.push(added);
              }
        }
      }
      for (const path of [...selected].sort()) {
        check();
        const entry = all.get(path);
        if (!entry) refuse();
        const label = inside(root, path) ? portable(relative(root, path)) : path;
        feed(key, label);
        feed(key, entry.stat.mode.toString());
        if (entry.link !== undefined) feed(key, `link:${entry.link}`);
        else if (entry.stat.isFile()) feed(key, (await read(entry)).digest);
        else feed(key, "directory");
      }
      for (const path of absentInstalledRoots) {
        try {
          await lstat(path);
          refuse();
        } catch (error) {
          if (!Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }))(error)) refuse();
        }
        feed(key, `absent-installed:${portable(relative(root, path))}`);
        feed(fence, `absent-installed:${path}`);
      }
      // Recheck all observed native names after the last byte read. This is a
      // change fence, not a global filesystem transaction or same-UID sandbox.
      phase = "changed";
      for (const [path, identity] of [...observed].sort(([a], [b]) => a.localeCompare(b))) {
        check();
        const current = await lstat(path, { bigint: true });
        if (observationIdentity(current) !== identity) refuse();
        const membership = memberships.get(path);
        if (
          membership &&
          membershipDigest(await relevantNames(path, membership.kind, maximumEntries)) !==
            membership.digest
        )
          refuse();
        feed(fence, path);
        // Ignored outputs may change a parent's mtime between before/after
        // snapshots. Retain namespace ownership, not those output timestamps.
        // Every traversal/final observation checks namespace identity and the
        // bounded filtered child-name set; selected files retain full metadata.
        feed(fence, identity);
        if (membership) feed(fence, membership.digest);
      }
      if (nullDeviceIdentity !== undefined) {
        const current = await lstat("/dev/null", { bigint: true });
        if (
          !current.isCharacterDevice() ||
          localVerificationNullDeviceIdentity(current) !== nullDeviceIdentity
        )
          refuse();
        feed(fence, "fixed-git-null-device");
        feed(fence, nullDeviceIdentity);
      }
      check();
      return { key: key.digest("hex"), fence: fence.digest("hex") };
    } catch {
      try {
        onRefusal?.(
          signal.aborted ? "cancelled" : phase,
          phase === "imports" ? detail : undefined,
          task,
        );
      } catch {
        /* Diagnostics never affect verification authority. */
      }
      return undefined;
    }
  };
}
