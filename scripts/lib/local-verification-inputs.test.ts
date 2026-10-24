// Fixtures own inert temporary files and a bounded metadata-only Node peer.
// They qualify input policy, not an ambient SDK; no compiler/browser/provider
// is launched, and the production developer-tool lookup remains unchanged.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
// Host-native temporary paths are the tested input boundary.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { delimiter, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import * as Schema from "effect/Schema";
import ts from "typescript";
import { describe, expect, it, vi, type TestContext } from "vitest";
import {
  createLocalVerificationFingerprint,
  localVerificationNullDeviceIdentity,
} from "./local-verification-inputs.ts";
import {
  createLocalVerificationCache,
  type LocalVerificationCacheDiagnostic,
} from "./local-verification-cache.ts";
import {
  localVerificationGitConfiguration,
  localVerificationGitEnvironment,
  prepareLocalVerificationTaskEnvironment,
} from "./local-verification-environment.ts";
import type {
  LocalVerificationInputRefusal,
  LocalVerificationInputDiagnostic,
} from "./local-verification-inputs.ts";
import type {
  LocalVerificationFingerprint,
  LocalVerificationInputSnapshot,
  LocalVerificationReceiptStore,
  LocalVerificationTask,
} from "./local-verification-cache-contract.ts";

const encode = Schema.encodeSync(Schema.UnknownFromJsonString);
const nullDevice = vi.hoisted(() => ({
  mode: "native" as
    | "native"
    | "regular"
    | "symlink"
    | "held-mismatch"
    | "named-mismatch"
    | "final-mismatch"
    | "timestamp-only",
  path: "",
  calls: 0,
}));
const selectedTool = vi.hoisted(() => ({ path: "", opens: 0, failNextOpen: false }));
const fixtureGitMetadata = vi.hoisted(() => ({
  owner: undefined as
    | {
        readonly signal: AbortSignal;
        retired: boolean;
        developer: string;
        corepack: string;
        git: string;
        result: "owned" | "empty" | "relative" | "outside" | "missing";
        invocations: number;
        closed: number;
      }
    | undefined,
}));
const typeScriptOutput = vi.hoisted(() => ({
  configPath: "",
  configRelative: "",
  configSubstitutions: 0,
  importer: "",
  modulePath: "",
  moduleRelative: "",
  moduleSubstitutions: 0,
}));
vi.mock("typescript", async (importOriginal) => {
  const native = await importOriginal<typeof ts & { readonly default?: typeof ts }>();
  const original = native.default ?? native;
  const methods = {
    parseJsonConfigFileContent(...args: Parameters<typeof original.parseJsonConfigFileContent>) {
      const parsed = original.parseJsonConfigFileContent(...args);
      if (
        typeScriptOutput.configPath !== "" &&
        args[4] === typeScriptOutput.configPath &&
        typeof parsed.options.configFilePath === "string" &&
        isAbsolute(parsed.options.configFilePath) &&
        resolve(parsed.options.configFilePath) === typeScriptOutput.configPath
      ) {
        typeScriptOutput.configSubstitutions += 1;
        return {
          ...parsed,
          options: { ...parsed.options, configFilePath: typeScriptOutput.configRelative },
        };
      }
      return parsed;
    },
    resolveModuleName(...args: Parameters<typeof original.resolveModuleName>) {
      const result = original.resolveModuleName(...args);
      const module = result.resolvedModule;
      if (
        typeScriptOutput.modulePath !== "" &&
        args[1] === typeScriptOutput.importer &&
        module !== undefined &&
        isAbsolute(module.resolvedFileName) &&
        resolve(module.resolvedFileName) === typeScriptOutput.modulePath
      ) {
        typeScriptOutput.moduleSubstitutions += 1;
        return {
          ...result,
          resolvedModule: { ...module, resolvedFileName: typeScriptOutput.moduleRelative },
        };
      }
      return result;
    },
  };
  // Preserve the real public API/default except these two exact controlled
  // return values. Some TS exports are nonconfigurable and cannot be spied on.
  return { ...native, ...methods, default: { ...original, ...methods } };
});
type NativeInputPhase =
  | "node-open-entered"
  | "node-open-settled"
  | "node-read-entered"
  | "node-read-progress"
  | "node-read-ended"
  | "node-closed"
  | "tool-open-entered"
  | "tool-open-settled"
  | "tool-read-entered"
  | "tool-read-progress"
  | "tool-read-ended"
  | "tool-closed"
  | "metadata-peer-entered"
  | "metadata-peer-result"
  | "metadata-peer-rejected"
  | "metadata-peer-closed"
  | "xcrun-entered"
  | "xcrun-result"
  | "xcrun-rejected"
  | "xcrun-closed";
const nativeInput = vi.hoisted(() => ({
  root: "",
  ordinal: 0,
  record: undefined as
    | ((phase: NativeInputPhase, ordinal?: number, bytes?: number, reads?: number) => void)
    | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const native = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...native,
    open(...args: Parameters<typeof native.open>) {
      // Observe only this test's exact owned selected tool. All successful IO
      // uses the real native descriptor/read/close path; the one-shot refusal
      // is an explicit admission negative, not a replacement filesystem.
      if (args[0] === selectedTool.path) {
        selectedTool.opens += 1;
        if (selectedTool.failNextOpen) {
          selectedTool.failNextOpen = false;
          return Promise.reject(Object.freeze({ code: "EIO" }));
        }
      }
      const record = nativeInput.record;
      const path = args[0];
      const bucket =
        record && typeof path === "string" && nativeInput.root !== ""
          ? path === process.execPath
            ? "node"
            : path !== "/dev/null" &&
                path !== nativeInput.root &&
                !path.startsWith(`${nativeInput.root}${process.platform === "win32" ? "\\" : "/"}`)
              ? "tool"
              : undefined
          : undefined;
      const ordinal = bucket ? Math.min(1_000_000, ++nativeInput.ordinal) : 0;
      if (bucket) record?.(`${bucket}-open-entered`, ordinal);
      const pending = native.open(...args);
      if (bucket && record) {
        // Observe the real handle without substituting its object, arguments,
        // receiver, returned promise, byte buffers or errors. Outside this
        // private root the producer reads only its admitted native tools.
        void pending.then(
          (file) => {
            try {
              record(`${bucket}-open-settled`, ordinal);
              let bytes = 0;
              let reads = 0;
              let nextProgress = 16 * 1024 ** 2;
              const originalRead = file.read;
              const originalClose = file.close;
              const observedRead = new Proxy(originalRead, {
                apply(target, receiver, argumentsList) {
                  if (reads === 0) record(`${bucket}-read-entered`, ordinal);
                  const result = Reflect.apply(target, receiver, argumentsList) as Promise<{
                    bytesRead: number;
                  }>;
                  void result.then(
                    ({ bytesRead }) => {
                      reads = Math.min(1_000_000, reads + 1);
                      bytes = Math.min(16 * 1024 ** 3, bytes + bytesRead);
                      if (bytesRead === 0) record(`${bucket}-read-ended`, ordinal, bytes, reads);
                      else if (bytes >= nextProgress) {
                        record(`${bucket}-read-progress`, ordinal, bytes, reads);
                        nextProgress = bytes + 16 * 1024 ** 2;
                      }
                    },
                    () => undefined,
                  );
                  return result;
                },
              });
              const observedClose = new Proxy(originalClose, {
                apply(target, receiver, argumentsList) {
                  const result = Reflect.apply(target, receiver, argumentsList) as Promise<void>;
                  void result.then(
                    () => {
                      try {
                        record(`${bucket}-closed`, ordinal, bytes, reads);
                        if (file.read === observedRead) file.read = originalRead;
                        if (file.close === observedClose) file.close = originalClose;
                      } catch {
                        /* Observation/restoration cannot reject the native close. */
                      }
                    },
                    () => undefined,
                  );
                  return result;
                },
              });
              file.read = observedRead;
              file.close = observedClose;
            } catch {
              /* An unavailable observation never changes native open/result. */
            }
          },
          () => undefined,
        );
      }
      return pending;
    },
    // Only synthetic negatives substitute the fixed device's observation.
    // All real fixture/source/tool IO delegates to the original native API;
    // /dev/null itself is never mutated, read, relinked or chmodded.
    async lstat(
      path: Parameters<typeof native.lstat>[0],
      options: Parameters<typeof native.lstat>[1],
    ) {
      if (path !== "/dev/null" || nullDevice.mode === "native") return native.lstat(path, options);
      nullDevice.calls += 1;
      if (nullDevice.mode === "regular" || nullDevice.mode === "symlink")
        return native.lstat(nullDevice.path, options);
      const stat = await native.lstat(path, options);
      const wrong =
        (nullDevice.mode === "held-mismatch" && nullDevice.calls === 1) ||
        (nullDevice.mode === "named-mismatch" && nullDevice.calls === 2) ||
        (nullDevice.mode === "final-mismatch" && nullDevice.calls === 3);
      if (wrong && typeof stat.rdev === "bigint")
        return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
          rdev: stat.rdev + 1n,
        });
      if (
        nullDevice.mode === "timestamp-only" &&
        "mtimeNs" in stat &&
        "ctimeNs" in stat &&
        typeof stat.mtimeNs === "bigint" &&
        typeof stat.ctimeNs === "bigint"
      ) {
        // A normal public null-device write can advance timestamps without
        // changing the held character device. Preserve every ownership/device
        // scalar while varying only the timestamps consumed by the old gate.
        const advance = BigInt(nullDevice.calls) * 1_000_000n;
        return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
          mtimeNs: stat.mtimeNs + advance,
          ctimeNs: stat.ctimeNs + advance,
        });
      }
      return stat;
    },
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const native = await importOriginal<typeof import("node:child_process")>();
  const { promisify, types } = await import("node:util");
  const execute = promisify(native.execFile);
  const ownValue = (value: unknown, key: string): unknown =>
    value !== null && typeof value === "object" && !types.isProxy(value)
      ? Object.getOwnPropertyDescriptor(value, key)?.value
      : undefined;
  const observedExecute = function (this: unknown, ...args: unknown[]) {
    const exactLookup =
      args.length === 3 &&
      args[0] === "/usr/bin/xcrun" &&
      Array.isArray(args[1]) &&
      args[1].length === 2 &&
      args[1][0] === "--find" &&
      args[1][1] === "git";
    const record = exactLookup ? nativeInput.record : undefined;
    const options = args[2];
    const environment = ownValue(options, "env");
    const candidate = fixtureGitMetadata.owner;
    const routedOwner =
      process.platform === "darwin" &&
      exactLookup &&
      candidate &&
      !candidate.retired &&
      !candidate.signal.aborted &&
      candidate.git !== "" &&
      ownValue(options, "signal") === candidate.signal &&
      ownValue(options, "encoding") === "utf8" &&
      ownValue(options, "shell") === false &&
      ownValue(options, "timeout") === 5_000 &&
      ownValue(options, "killSignal") === "SIGKILL" &&
      ownValue(options, "maxBuffer") === 4_096 &&
      ownValue(environment, "DEVELOPER_DIR") === candidate.developer &&
      ownValue(environment, "COREPACK_ROOT") === candidate.corepack
        ? candidate
        : undefined;
    let nativeArgs = args;
    if (routedOwner) {
      // This input-policy fixture does not qualify an ambient Xcode SDK. Only
      // the exact held owner's fixed lookup may use this synthetic metadata.
      // Keep a REAL native peer and the ORIGINAL options object, signal,
      // result promise, errors and .child; never synthesize native close.
      const output =
        routedOwner.result === "empty"
          ? ""
          : routedOwner.result === "relative"
            ? "git"
            : routedOwner.result === "outside"
              ? process.execPath
              : routedOwner.result === "missing"
                ? join(routedOwner.developer, "missing-git")
                : routedOwner.git;
      nativeArgs = [
        process.execPath,
        ["-e", "process.stdout.write(process.argv[1] + '\\n');", output],
        options,
      ];
      routedOwner.invocations += 1;
    }
    record?.(routedOwner ? "metadata-peer-entered" : "xcrun-entered");
    // Every foreign, retired or nonmatching invocation still delegates the
    // original command. The production helper retains its exact close join.
    const pending = Reflect.apply(execute, this, nativeArgs) as ReturnType<typeof execute> & {
      child: ReturnType<typeof native.spawn>;
    };
    if (routedOwner)
      pending.child.once("close", () => {
        routedOwner.closed += 1;
      });
    if (record) {
      pending.child.once("close", () =>
        record(routedOwner ? "metadata-peer-closed" : "xcrun-closed"),
      );
      void pending.then(
        () => record(routedOwner ? "metadata-peer-result" : "xcrun-result"),
        () => record(routedOwner ? "metadata-peer-rejected" : "xcrun-rejected"),
      );
    }
    return pending;
  };
  return {
    ...native,
    // The native function's custom-promisifier property can be nonconfigurable;
    // do not mutate it or violate a Proxy get invariant while observing it.
    execFile: Object.assign(
      function (this: unknown, ...args: Parameters<typeof native.execFile>) {
        return Reflect.apply(native.execFile, this, args) as ReturnType<typeof native.execFile>;
      },
      { [promisify.custom]: observedExecute },
    ),
  };
});

function observeNativeToolPhases(context: TestContext) {
  const started = performance.now();
  let retired = false;
  let omitted = 0;
  const phases: {
    phase: NativeInputPhase;
    elapsedMs: number;
    ordinal: number;
    bytes: number;
    reads: number;
  }[] = [];
  const bounded = (value: number, maximum: number) =>
    Number.isFinite(value) ? Math.max(0, Math.min(maximum, Math.floor(value))) : 0;
  const record = (phase: NativeInputPhase, ordinal = 0, bytes = 0, reads = 0) => {
    try {
      if (retired) return;
      if (phases.length === 16) {
        phases.shift();
        omitted = Math.min(1_000_000, omitted + 1);
      }
      phases.push({
        phase,
        elapsedMs: bounded(performance.now() - started, 60_000),
        ordinal: bounded(ordinal, 1_000_000),
        bytes: bounded(bytes, 16 * 1024 ** 3),
        reads: bounded(reads, 1_000_000),
      });
    } catch {
      /* Never give this diagnostic callback authority over native operations. */
    }
  };
  nativeInput.root = "";
  nativeInput.ordinal = 0;
  nativeInput.record = record;
  context.onTestFailed(() => {
    try {
      process.stderr.write(`Synthetic native-tool phases: ${encode({ phases, omitted })}\n`);
    } catch {
      /* Observations cannot replace the original native/test failure. */
    }
  });
  return {
    bindRoot(root: string) {
      if (!retired && nativeInput.record === record) nativeInput.root = root;
    },
    retire() {
      retired = true;
      if (nativeInput.record === record) {
        nativeInput.record = undefined;
        nativeInput.root = "";
      }
    },
  };
}

function relativeTypeScriptResult(path: string): string {
  let candidate = relative(process.cwd(), path);
  if (process.platform === "win32" && isAbsolute(candidate)) {
    // A temp root can be on another local drive. Use that drive's native
    // relative-path semantics without changing cwd, environment or volumes.
    // UNC/other namespaces cannot supply this exact relative-result control.
    const drive = parse(path).root.slice(0, 2);
    if (!/^[a-zA-Z]:$/u.test(drive))
      throw new Error("Synthetic TypeScript result requires a local drive");
    candidate = drive + relative(resolve(drive), path);
  }
  return candidate;
}

async function fixture(context: TestContext, afterClosed?: () => void) {
  if (fixtureGitMetadata.owner) throw new Error("Synthetic metadata fixture is still held");
  const metadataOwner: NonNullable<(typeof fixtureGitMetadata)["owner"]> = {
    signal: context.signal,
    retired: false,
    developer: "",
    corepack: "",
    git: "",
    result: "owned",
    invocations: 0,
    closed: 0,
  };
  // Admit this exact routing owner before acquisition or any await. It cannot
  // mint metadata after retirement, and is released only after native drain.
  fixtureGitMetadata.owner = metadataOwner;
  // Install before acquisition; retire only after this owner's exact pending
  // fingerprint/child/descriptor work drains, before the root can be removed.
  const nativeObservation = observeNativeToolPhases(context);
  let retired = false;
  let ownedRoot: string | undefined;
  let acquisition: Promise<string> | undefined;
  const pending = new Set<Promise<unknown>>();
  const retire = () => {
    retired = true;
    metadataOwner.retired = true;
  };
  const assertActive = () => {
    if (retired || context.signal.aborted) throw new Error("Synthetic input fixture retired");
  };
  const own = <T>(start: () => Promise<T>): Promise<T> => {
    assertActive();
    const promise = start();
    pending.add(promise);
    // Return the original operation/error to its caller. The second owner only
    // tracks settlement, never converts a refusal or failure into success.
    void promise.then(
      () => {
        pending.delete(promise);
      },
      () => {
        pending.delete(promise);
      },
    );
    return promise;
  };
  context.signal.addEventListener("abort", retire, { once: true });
  context.onTestFinished(async () => {
    retire(); // Fence new IO before joining exactly the already-admitted work.
    try {
      if (acquisition) await Promise.allSettled([acquisition]);
      await Promise.allSettled([...pending]);
      // The null-device observation mock may retire only after the producer's
      // actual IO/abort finalizers have closed, not merely after test timeout.
      try {
        nativeObservation.retire();
        if (fixtureGitMetadata.owner === metadataOwner) fixtureGitMetadata.owner = undefined;
        afterClosed?.();
      } finally {
        if (ownedRoot) await rm(ownedRoot, { recursive: true, force: true });
      }
    } finally {
      context.signal.removeEventListener("abort", retire);
    }
  });
  assertActive();
  acquisition = mkdtemp(join(tmpdir(), "cafe-inputs-")).then(async (created) => {
    ownedRoot = created;
    const canonical = await realpath(created);
    ownedRoot = canonical;
    return canonical;
  });
  const root = await acquisition;
  assertActive();
  nativeObservation.bindRoot(root);
  const put = (name: string, value: string) =>
    own(async () => {
      const path = join(root, name);
      await mkdir(dirname(path), { recursive: true });
      assertActive();
      await writeFile(path, value, { mode: 0o600 });
      assertActive();
      return path;
    });
  // Wrapper preparation includes native mkdir/chmod operations as well as
  // whole dependent chains. Retire admission before cleanup, join every held
  // operation, and reject successful late settlement without replacing an
  // original native rejection with a synthetic error.
  const ownPreparation = <T>(operation: () => Promise<T>): Promise<T> =>
    own(async () => {
      const result = await operation();
      assertActive();
      return result;
    });
  await put(
    "package.json",
    encode({ packageManager: "yarn@4.17.1", workspaces: ["apps/*", "packages/*", "scripts"] }),
  );
  for (const [location, name] of [
    ["apps/server", "@cafeai/cafe-code"],
    ["apps/web", "@cafecode/web"],
    ["packages/shared", "@cafecode/shared"],
    ["scripts", "@cafecode/scripts"],
  ]) {
    await put(`${location}/package.json`, encode({ name }));
    await put(
      `${location}/tsconfig.json`,
      encode({
        extends: "../../tsconfig.base.json",
        compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" },
      }),
    );
  }
  // The scripts location has a one-level parent, like the actual checkout.
  await put("scripts/tsconfig.json", encode({ extends: "../tsconfig.base.json" }));
  await put("tsconfig.base.json", encode({ compilerOptions: { strict: true } }));
  await put("yarn.lock", "inert lock\n");
  await put("apps/server/src/value.ts", "export const value = 1;\n");
  await put("apps/server/src/entry.test.ts", 'import "./value.ts";\n');
  await put("apps/web/src/unused.browser.tsx", "export const unrelatedBrowserCase = 1;\n");
  await put("apps/web/src/index.css", "body { color: red; }\n");
  await put("apps/web/browser-test-policy.json", "{}\n");
  await put("packages/shared/src/value.ts", "export const sharedValue = 1;\n");
  await put("node_modules/inert/package.json", encode({ name: "inert", version: "1.0.0" }));
  await put("node_modules/inert/index.js", "export const dependency = 1;\n");
  await put("node_modules/typescript/lib/_tsc.js", "// inert compiler bytes, never executed\n");
  const yarn = await put("tools/yarn.cjs", "// inert selected Yarn, never executed\n");
  const corepack = join(root, "tools/corepack");
  await put("tools/corepack/package.json", encode({ name: "corepack", version: "inert" }));
  await put("tools/corepack/dist/yarn.js", "// inert Corepack, never executed\n");
  const developer = join(root, "tools/developer");
  const git =
    process.platform === "darwin"
      ? await put("tools/developer/git", "#!/bin/sh\nexit 0\n")
      : undefined;
  if (git !== undefined) {
    await ownPreparation(() => chmod(git, 0o700));
    metadataOwner.developer = developer;
    metadataOwner.corepack = corepack;
    metadataOwner.git = git;
  }
  await put("scripts/fixtures/local-verification-git.config", localVerificationGitConfiguration);
  await put("scripts/fixtures/local-verification-git-template/.gitkeep", "");
  const store = {
    authenticateEnvironment: vi.fn((environment: Readonly<Record<string, string | undefined>>) =>
      createHash("sha256")
        .update(encode(Object.entries(environment).sort()))
        .digest("hex"),
    ),
    read: vi.fn(async () => false),
    publish: vi.fn(async () => true),
  } satisfies LocalVerificationReceiptStore;
  const environment = {
    PATH: [
      ...(git !== undefined ? [dirname(git)] : []),
      dirname(process.execPath),
      process.platform === "win32" ? (process.env.SystemRoot ?? "C:\\Windows") : "/usr/bin",
      process.platform === "win32"
        ? join(process.env.SystemRoot ?? "C:\\Windows", "System32")
        : "/bin",
      ...(process.env.PATH ?? "").split(delimiter),
    ].join(delimiter),
    COREPACK_ROOT: corepack,
    npm_execpath: yarn,
    NODE_OPTIONS: "--max-old-space-size=4096",
    ...(process.platform === "darwin" ? { DEVELOPER_DIR: developer } : {}),
    ...localVerificationGitEnvironment(root),
  };
  const task: LocalVerificationTask = {
    id: "server-node",
    cwd: root,
    args: ["test", "--filter=@cafeai/cafe-code", "--concurrency=1"],
    environment,
    scope: { kind: "node", workspace: "apps/server" },
  };
  const refusals: {
    reason: LocalVerificationInputRefusal;
    detail?: LocalVerificationInputDiagnostic;
  }[] = [];
  const createFingerprint = (
    receiptStore: LocalVerificationReceiptStore,
  ): LocalVerificationFingerprint => {
    const observe = createLocalVerificationFingerprint(root, receiptStore, (reason, detail) => {
      refusals.push({ reason, ...(detail ? { detail } : {}) });
    });
    return (task, signal) =>
      own(async () => {
        const result = await observe(task, signal);
        assertActive();
        return result;
      });
  };
  const fingerprint = createFingerprint(store);
  const createFileLink = (target: string, path: string) =>
    own(async () => {
      await symlink(target, path);
      // A retired native link may settle, but cannot resume a shared-mock
      // mutation after owned cleanup has drained and reset that observation.
      assertActive();
    });
  return {
    root,
    put,
    store,
    task,
    fingerprint,
    createFingerprint,
    createFileLink,
    ownPreparation,
    refusals,
    metadataObservation: () => ({
      invocations: metadataOwner.invocations,
      closed: metadataOwner.closed,
    }),
    setMetadataResult(result: typeof metadataOwner.result) {
      assertActive();
      metadataOwner.result = result;
    },
    snapshot: () => fingerprint(task, context.signal),
  };
}

async function selectedToolFixture(context: TestContext) {
  const f = await fixture(context, () => {
    // The ordinary fixture drains all admitted preparation/fingerprint IO
    // before this shared exact-path observation may belong to another case.
    selectedTool.path = "";
    selectedTool.opens = 0;
    selectedTool.failNextOpen = false;
  });
  const toolBytes = "#!/bin/sh\nexit 0\n";
  const path = await f.put(
    `tools/selected-git/${process.platform === "win32" ? "git.exe" : "git"}`,
    toolBytes,
  );
  await f.ownPreparation(() => chmod(path, 0o700));
  // A whole-second fixture mtime can be restored exactly with the native API;
  // the byte-mutation control must not accidentally rely on rounded mtime.
  await f.ownPreparation(() => utimes(path, 1_700_000_000, 1_700_000_000));
  const task: LocalVerificationTask = {
    ...f.task,
    environment: {
      ...f.task.environment,
      PATH: [dirname(path), f.task.environment.PATH].join(delimiter),
    },
  };
  selectedTool.path = path;
  selectedTool.opens = 0;
  selectedTool.failNextOpen = false;
  const snapshot = (store: LocalVerificationReceiptStore = f.store) =>
    f.createFingerprint(store)(task, context.signal);
  return { ...f, path, toolBytes, task, snapshot };
}

async function yarnPathFixture(
  context: TestContext,
  afterClosed?: () => void,
  observePreparation?: (phase: "base-ready" | "wrappers-entered" | "wrappers-settled") => void,
) {
  const f = await fixture(context, afterClosed);
  observePreparation?.("base-ready");
  const one = join(f.root, "tools/xfs-11111111");
  const two = join(f.root, "tools/xfs-22222222");
  const node = `#!/bin/sh\nexec "${process.execPath}"  "$@"\n`;
  const yarn = `#!/bin/sh\nexec "${process.execPath}" '${join(f.root, "tools/corepack/dist/yarn.js")}' "$@"\n`;
  // Both directories exist before either observation. Only their exact
  // forwarding bytes/modes can authorize path interchangeability; no native
  // executable or package-manager process is run by these inert fixtures.
  // Only these two independent wrapper chains overlap. Every chain and each
  // native mutation is held by the same fixture owner, so an early aggregate
  // rejection cannot abandon its sibling or race root removal. Within each
  // wrapper preserve the original creation/write/permission order exactly.
  observePreparation?.("wrappers-entered");
  await Promise.all(
    (
      [
        ["xfs-11111111", one],
        ["xfs-22222222", two],
      ] as const
    ).map(([name, path]) =>
      f.ownPreparation(async () => {
        await f.ownPreparation(() => mkdir(path, { mode: 0o700 }));
        await f.put(`tools/${name}/node`, node);
        await f.put(`tools/${name}/yarn`, yarn);
        await f.ownPreparation(() => chmod(join(path, "node"), 0o700));
        await f.ownPreparation(() => chmod(join(path, "yarn"), 0o700));
      }),
    ),
  );
  observePreparation?.("wrappers-settled");
  const snapshot = (overrides: Readonly<Record<string, string | undefined>> = {}) =>
    f.fingerprint(
      {
        ...f.task,
        environment: {
          ...f.task.environment,
          BERRY_BIN_FOLDER: one,
          PATH: [one, two, f.task.environment.PATH].join(delimiter),
          npm_execpath: join(one, "yarn"),
          npm_node_execpath: join(one, "node"),
          ...overrides,
        },
      },
      context.signal,
    );
  return { ...f, one, two, node, yarn, snapshot };
}

/** Fixed failure-only evidence for the two wrapper identity regressions. */
function observeYarnInputPhases(context: TestContext, label: "entry-name" | "executable-mode") {
  const started = performance.now();
  type Phase =
    | "fixture-entered"
    | "fixture-ready"
    | "base-ready"
    | "wrappers-entered"
    | "wrappers-settled"
    | "snapshot-entered"
    | "snapshot-settled"
    | "mutation-entered"
    | "mutation-settled"
    | "owned-closed";
  let retired = false;
  let refusals: readonly { readonly reason: LocalVerificationInputRefusal }[] | undefined;
  const phases: {
    phase: Phase;
    elapsedMs: number;
    refusal: LocalVerificationInputRefusal | "none";
    ordinal: number;
  }[] = [];
  const mark = (phase: Phase, ordinal = 0) => {
    if (retired || phases.length >= 16) return;
    const elapsed = performance.now() - started;
    phases.push({
      phase,
      elapsedMs: Number.isFinite(elapsed) ? Math.max(0, Math.min(60_000, Math.round(elapsed))) : 0,
      refusal: refusals?.at(-1)?.reason ?? "none",
      ordinal: Number.isSafeInteger(ordinal) ? Math.max(0, Math.min(2, ordinal)) : 0,
    });
  };
  // Register before acquisition or native setup. No path, environment, source
  // bytes, received error or fingerprint is projected by this observation.
  context.onTestFailed(() => {
    try {
      process.stderr.write(`Synthetic Yarn ${label} phases: ${encode(phases)}\n`);
    } catch {
      /* Diagnostic delivery never alters the original failure. */
    }
  });
  return {
    mark,
    bindRefusals(value: readonly { readonly reason: LocalVerificationInputRefusal }[]) {
      if (!retired) refusals = value;
    },
    ownedClosed() {
      mark("owned-closed");
      retired = true;
    },
  };
}

/** Only the two diagnosed native-input contracts use this fixed phase ledger.
 * Keep the latest sixteen rows so even a late fifth snapshot and exact owned
 * cleanup remain visible; no source, argv, environment or error is retained.
 */
function observeNativeInputPhases(
  context: TestContext,
  label: "null-device-negative" | "vitest-output",
) {
  type Phase =
    | "fixture-entered"
    | "fixture-ready"
    | "installed-roots-ready"
    | "variant-entered"
    | "variant-settled"
    | "snapshot-entered"
    | "snapshot-settled"
    | "writes-entered"
    | "writes-settled"
    | "owned-closed";
  const started = performance.now();
  let retired = false;
  let omitted = 0;
  let refusals: readonly { readonly reason: LocalVerificationInputRefusal }[] | undefined;
  const phases: {
    phase: Phase;
    elapsedMs: number;
    ordinal: number;
    refusal: LocalVerificationInputRefusal | "none";
  }[] = [];
  const mark = (phase: Phase, ordinal = 0) => {
    if (retired) return;
    if (phases.length === 16) {
      phases.shift();
      omitted = Math.min(1_000_000, omitted + 1);
    }
    const elapsed = performance.now() - started;
    phases.push({
      phase,
      elapsedMs: Number.isFinite(elapsed) ? Math.max(0, Math.min(60_000, Math.round(elapsed))) : 0,
      ordinal: Number.isSafeInteger(ordinal) ? Math.max(0, Math.min(5, ordinal)) : 0,
      refusal: refusals?.at(-1)?.reason ?? "none",
    });
  };
  // Register before fixture acquisition, and retire only after its exact IO
  // owner has drained. Diagnostic delivery never owns task success or failure.
  context.onTestFailed(() => {
    try {
      process.stderr.write(`Synthetic ${label} input phases: ${encode({ phases, omitted })}\n`);
    } catch {
      /* Keep the original test failure when diagnostic delivery is unavailable. */
    }
  });
  return {
    mark,
    bindRefusals(value: readonly { readonly reason: LocalVerificationInputRefusal }[]) {
      refusals = value;
    },
    ownedClosed() {
      mark("owned-closed");
      retired = true;
    },
  };
}

describe("local verification input evidence", () => {
  it("refuses unsupported runtime hooks and conflicting server Git profiles before inventory", async (context) => {
    const f = await fixture(context);
    for (const [name, value] of [
      ["NODE_PATH", "/synthetic/unread-module-hook"],
      ["NODE_OPTIONS", "--import=/synthetic/unread-module-hook.mjs"],
      ["BASH_ENV", "/synthetic/unread-shell-hook"],
      ["ENV", "/synthetic/unread-shell-hook"],
      ["GIT_CONFIG_GLOBAL", "/synthetic/unread-git-config"],
      ["GIT_TEMPLATE_DIR", "/synthetic/unread-template"],
      ["GIT_CONFIG_COUNT", "1"],
    ] as const) {
      const environment = { ...f.task.environment, [name]: value };
      const unsupported = { ...f.task, cwd: join(f.root, "not-created"), environment };
      expect(await f.fingerprint(unsupported, context.signal)).toBeUndefined();
      expect(f.refusals.at(-1)?.reason).toBe("environment");
      if (
        name === "NODE_PATH" ||
        name === "NODE_OPTIONS" ||
        name === "BASH_ENV" ||
        name === "ENV" ||
        name === "GIT_CONFIG_COUNT"
      ) {
        expect(
          await f.fingerprint(
            { ...unsupported, scope: { kind: "node", workspace: "scripts" } },
            context.signal,
          ),
        ).toBeUndefined();
        expect(f.refusals.at(-1)?.reason).toBe("environment");
      }
    }
    const missing = { ...f.task.environment, GIT_CONFIG_GLOBAL: undefined };
    expect(
      await f.fingerprint({ ...f.task, environment: missing }, context.signal),
    ).toBeUndefined();
    expect(f.refusals.at(-1)?.reason).toBe("environment");
    expect(f.store.authenticateEnvironment).not.toHaveBeenCalled();
  });

  it("refuses external includes and nonempty controlled templates rather than admitting their unknown data", async (context) => {
    const f = await fixture(context);
    await f.put(
      "scripts/fixtures/local-verification-git.config",
      `${localVerificationGitConfiguration}[include]\npath=/synthetic/unread-config\n`,
    );
    expect(await f.snapshot()).toBeUndefined();
    expect(f.refusals.at(-1)?.reason).toBe("environment");
    await f.put(
      "scripts/fixtures/local-verification-git.config",
      localVerificationGitConfiguration,
    );
    await f.put(
      "scripts/fixtures/local-verification-git-template/hooks/commit-msg",
      "inert unexpected template bytes\n",
    );
    expect(await f.snapshot()).toBeUndefined();
    expect(f.refusals.at(-1)?.reason).toBe("environment");
    expect(f.store.authenticateEnvironment).not.toHaveBeenCalled();
  });

  it("binds every null-device identity scalar while ignoring only its payload-free timestamps", () => {
    const device = {
      dev: 1n,
      ino: 2n,
      mode: 0o20666n,
      nlink: 1n,
      uid: 0n,
      gid: 0n,
      rdev: 3n,
      mtimeNs: 4n,
      ctimeNs: 5n,
    };
    const identity = localVerificationNullDeviceIdentity(device);
    for (const variation of [
      { ...device, mtimeNs: device.mtimeNs + 1n },
      { ...device, ctimeNs: device.ctimeNs + 1n },
      { ...device, mtimeNs: device.mtimeNs + 1n, ctimeNs: device.ctimeNs + 1n },
    ]) {
      expect(localVerificationNullDeviceIdentity(variation)).toBe(identity);
    }
    for (const field of ["dev", "ino", "mode", "nlink", "uid", "gid", "rdev"] as const) {
      expect(
        localVerificationNullDeviceIdentity({ ...device, [field]: device[field] + 1n }),
      ).not.toBe(identity);
    }
  });

  it.skipIf(process.platform === "win32")(
    "admits a full timestamp-varied null-device observation through its native ownership guards",
    async (context) => {
      const started = performance.now();
      type Phase =
        | "fixture-entered"
        | "fixture-ready"
        | "first-entered"
        | "first-settled"
        | "owned-closed";
      let refusals: readonly { readonly reason: LocalVerificationInputRefusal }[] | undefined;
      const observations: {
        phase: Phase;
        elapsedMs: number;
        refusal: LocalVerificationInputRefusal | "none";
        deviceObservations: number;
      }[] = [];
      const mark = (phase: Phase) => {
        if (observations.length >= 16) return;
        const elapsed = performance.now() - started;
        observations.push({
          phase,
          elapsedMs: Number.isFinite(elapsed)
            ? Math.max(0, Math.min(60_000, Math.round(elapsed)))
            : 0,
          refusal: refusals?.at(-1)?.reason ?? "none",
          deviceObservations: Number.isSafeInteger(nullDevice.calls)
            ? Math.max(0, Math.min(1_000_000, nullDevice.calls))
            : 0,
        });
      };
      // Failure hooks run after owned completion cleanup. Only fixed phases,
      // finite durations/categories and counts are observed; never error text,
      // task input, native paths, environment or source content.
      context.onTestFailed(() => {
        try {
          process.stderr.write(
            `Synthetic null-device observation phases: ${encode(observations)}\n`,
          );
        } catch {
          /* Diagnostic delivery never alters the original failure. */
        }
      });
      mark("fixture-entered");
      const f = await fixture(context, () => {
        mark("owned-closed");
        nullDevice.mode = "native";
        nullDevice.path = "";
        nullDevice.calls = 0;
      });
      refusals = f.refusals;
      mark("fixture-ready");
      nullDevice.mode = "timestamp-only";
      nullDevice.calls = 0;
      try {
        mark("first-entered");
        const first = await f.snapshot();
        mark("first-settled");
        expect(first, encode(f.refusals)).toBeDefined();
        // The pure policy above covers timestamp equality and every identity
        // scalar; this real consumer proves all three named observations and
        // the unmodified held-descriptor checks admit that same policy.
        expect(nullDevice.calls).toBe(3);
        if (process.platform === "darwin")
          expect(f.metadataObservation()).toEqual({ invocations: 1, closed: 1 });
      } finally {
        nullDevice.mode = "native";
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses substituted null devices and changed held/named device identities",
    async (context) => {
      const observation = observeNativeInputPhases(context, "null-device-negative");
      observation.mark("fixture-entered");
      const f = await fixture(context, () => {
        observation.ownedClosed();
        nullDevice.mode = "native";
        nullDevice.path = "";
        nullDevice.calls = 0;
      });
      observation.bindRefusals(f.refusals);
      const ordinary = await f.put("tools/not-a-null-device", "must never be read as a device\n");
      const alias = join(f.root, "tools/null-device-alias");
      await f.createFileLink(ordinary, alias);
      observation.mark("fixture-ready");
      const modes = [
        "regular",
        "symlink",
        "held-mismatch",
        "named-mismatch",
        "final-mismatch",
      ] as const;
      for (const [index, mode] of modes.entries()) {
        nullDevice.path = mode === "symlink" ? alias : ordinary;
        nullDevice.mode = mode;
        nullDevice.calls = 0;
        try {
          observation.mark("variant-entered", index + 1);
          const snapshot = await f.snapshot();
          observation.mark("variant-settled", index + 1);
          expect(snapshot).toBeUndefined();
          expect(nullDevice.calls).toBeGreaterThan(0);
          expect(f.refusals.at(-1)?.reason).toBe(
            mode === "final-mismatch" ? "changed" : "environment",
          );
        } finally {
          nullDevice.mode = "native";
        }
      }
      expect(f.store.authenticateEnvironment).toHaveBeenCalledTimes(1);
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "refuses malformed and unowned developer Git metadata after its exact native peer closes",
    async (context) => {
      const f = await fixture(context);
      for (const [index, result] of (
        ["empty", "relative", "outside", "missing"] as const
      ).entries()) {
        f.setMetadataResult(result);
        expect(await f.snapshot()).toBeUndefined();
        expect(f.refusals.at(-1)?.reason).toBe("tools");
        expect(f.metadataObservation()).toEqual({ invocations: index + 1, closed: index + 1 });
        expect(f.store.authenticateEnvironment).not.toHaveBeenCalled();
        expect(f.store.read).not.toHaveBeenCalled();
        expect(f.store.publish).not.toHaveBeenCalled();
      }
    },
  );

  it("publishes a real coordinator receipt when absent generated outputs first appear and reuses it after nested output writes", async (context) => {
    const started = performance.now();
    type Phase =
      | "fixture-entered"
      | "fixture-ready"
      | "snapshot-entered"
      | "snapshot-settled"
      | "first-outputs-entered"
      | "first-outputs-settled"
      | "later-outputs-entered"
      | "later-outputs-settled"
      | "owned-closed";
    let retired = false;
    let refusals: readonly { readonly reason: LocalVerificationInputRefusal }[] | undefined;
    const phases: {
      phase: Phase;
      elapsedMs: number;
      refusal: LocalVerificationInputRefusal | "none";
      ordinal: number;
    }[] = [];
    const mark = (phase: Phase, ordinal = 0) => {
      if (retired || phases.length >= 16) return;
      const elapsed = performance.now() - started;
      phases.push({
        phase,
        elapsedMs: Number.isFinite(elapsed)
          ? Math.max(0, Math.min(60_000, Math.round(elapsed)))
          : 0,
        refusal: refusals?.at(-1)?.reason ?? "none",
        ordinal: Number.isSafeInteger(ordinal) ? Math.max(0, Math.min(5, ordinal)) : 0,
      });
    };
    // Observe only fixed phases and finite categories/counts on failure. The
    // fixture closes its owned IO before retiring this private observation.
    context.onTestFailed(() => {
      try {
        process.stderr.write(`Synthetic generated-output phases: ${encode(phases)}\n`);
      } catch {
        /* Diagnostic delivery never alters the original failure. */
      }
    });
    mark("fixture-entered");
    const f = await fixture(context, () => {
      mark("owned-closed");
      retired = true;
    });
    refusals = f.refusals;
    await f.put("apps/web/src/components/Fixture.browser.tsx", "export {};\n");
    mark("fixture-ready");
    const receipts = new Set<string>();
    const store: LocalVerificationReceiptStore = {
      authenticateEnvironment: f.store.authenticateEnvironment,
      read: vi.fn(async (key: string) => receipts.has(key)),
      publish: vi.fn(async (key: string, signal: AbortSignal) => {
        if (signal.aborted) return false;
        receipts.add(key);
        return true;
      }),
    };
    const observeFingerprint = f.createFingerprint(store);
    const snapshots: (LocalVerificationInputSnapshot | undefined)[] = [];
    let snapshotsStarted = 0;
    const fingerprint: LocalVerificationFingerprint = async (task, signal) => {
      const ordinal = Math.min(5, ++snapshotsStarted);
      mark("snapshot-entered", ordinal);
      const snapshot = await observeFingerprint(task, signal);
      snapshots.push(snapshot);
      mark("snapshot-settled", ordinal);
      return snapshot;
    };
    const task: LocalVerificationTask = {
      ...f.task,
      id: "repository-output-producer",
      scope: { kind: "node", workspace: "scripts" },
    };
    const cache = createLocalVerificationCache({ store, fingerprint });
    const observations: LocalVerificationCacheDiagnostic[] = [];
    const execute = vi.fn(async () => {
      mark("first-outputs-entered");
      // These disjoint real writes share no ordering contract. Each put is
      // individually owned and drained before the fixture removes its root.
      await Promise.all([
        f.put("build/fixture/output.js", "first generated build bytes\n"),
        f.put(".explorations/fixture/output.png", "first generated observation bytes\n"),
        f.put(
          "apps/web/src/components/__screenshots__/Fixture.browser.tsx/default.png",
          "first native screenshot output\n",
        ),
        f.put("apps/web/.tanstack/tmp/01234567-fixture", "inert router temporary output\n"),
      ]);
      mark("first-outputs-settled");
    });
    expect(
      (
        await cache.run(task, context.signal, execute, (diagnostic) =>
          observations.push(diagnostic),
        )
      ).status,
    ).toBe("fresh");
    // Observe the actual pre-execution, post-close and post-publication checks
    // rather than repeating native inventories for an artificial comparison.
    expect(snapshots).toHaveLength(3);
    const before = snapshots[0];
    expect(before).toBeDefined();
    expect(snapshots[1]).toEqual(before);
    expect(snapshots[2]).toEqual(before);
    expect(observations.at(-1)).toMatchObject({
      phase: "post-publication",
      outcome: "admitted",
      key: "same",
      fence: "same",
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(store.publish).toHaveBeenCalledExactlyOnceWith(before?.key, context.signal);
    mark("later-outputs-entered");
    await Promise.all([
      f.put("build/fixture/nested/later.js", "later generated build bytes\n"),
      f.put(".explorations/fixture/nested/later.png", "later generated observation bytes\n"),
      f.put(
        "apps/web/src/components/__screenshots__/Fixture.browser.tsx/later.png",
        "later native screenshot output\n",
      ),
      f.put("apps/web/.tanstack/tmp/89abcdef-fixture", "later router temporary output\n"),
    ]);
    mark("later-outputs-settled");
    expect(
      (
        await cache.run(task, context.signal, execute, (diagnostic) =>
          observations.push(diagnostic),
        )
      ).status,
    ).toBe("reused");
    expect(snapshots).toHaveLength(5);
    expect(snapshots[3]).toEqual(before);
    expect(snapshots[4]).toEqual(before);
    expect(observations.at(-1)).toMatchObject({
      phase: "reuse-recheck",
      outcome: "admitted",
      key: "same",
      fence: "same",
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(store.publish).toHaveBeenCalledTimes(1);
  });

  it("stores and reuses server success when installed Vitest module caches first appear and are rewritten", async (context) => {
    const observation = observeNativeInputPhases(context, "vitest-output");
    observation.mark("fixture-entered");
    const f = await fixture(context, () => observation.ownedClosed());
    observation.bindRefusals(f.refusals);
    observation.mark("fixture-ready");
    // Admit the installed roots before baseline capture. This qualifies only
    // generated cache output, not a new dependency installation mid-task.
    await f.ownPreparation(() =>
      mkdir(join(f.root, "apps/server/node_modules"), { recursive: true }),
    );
    observation.mark("installed-roots-ready");
    const receipts = new Set<string>();
    const store: LocalVerificationReceiptStore = {
      authenticateEnvironment: f.store.authenticateEnvironment,
      read: vi.fn(async (key: string) => receipts.has(key)),
      publish: vi.fn(async (key: string, signal: AbortSignal) => {
        if (signal.aborted) return false;
        receipts.add(key);
        return true;
      }),
    };
    let snapshotsStarted = 0;
    const fingerprint: LocalVerificationFingerprint = async (task, signal) => {
      const ordinal = ++snapshotsStarted;
      observation.mark("snapshot-entered", ordinal);
      const snapshot = await f.fingerprint(task, signal);
      observation.mark("snapshot-settled", ordinal);
      return snapshot;
    };
    const cache = createLocalVerificationCache({ store, fingerprint });
    const observations: LocalVerificationCacheDiagnostic[] = [];
    const outputs = ["node_modules/.vitest-cache", "apps/server/node_modules/.vitest-cache"];
    const writeOutputs = async (revision: string) => {
      for (const output of outputs) {
        await f.put(`${output}/_metadata.json`, encode({ lockfileHash: revision }));
        await f.put(`${output}/${"a".repeat(40)}`, `// inert derived transform ${revision}\n`);
        await f.put(`${output}/CACHEDIR.TAG`, "Signature: 8a477f597d28d172789f06886806bc55\n");
      }
    };
    const execute = vi.fn(async () => {
      observation.mark("writes-entered", 1);
      await writeOutputs("first");
      observation.mark("writes-settled", 1);
    });
    expect(
      (
        await cache.run(f.task, context.signal, execute, (diagnostic) =>
          observations.push(diagnostic),
        )
      ).status,
    ).toBe("fresh");
    expect(observations.at(-1)).toMatchObject({
      phase: "post-publication",
      outcome: "admitted",
      key: "same",
      fence: "same",
    });
    expect(store.publish).toHaveBeenCalledOnce();
    expect(receipts.size).toBe(1);
    observation.mark("writes-entered", 2);
    await writeOutputs("rewritten");
    for (const output of outputs)
      await f.put(`${output}/${"b".repeat(40)}`, "// another derived transform\n");
    observation.mark("writes-settled", 2);
    expect(
      (
        await cache.run(f.task, context.signal, execute, (diagnostic) =>
          observations.push(diagnostic),
        )
      ).status,
    ).toBe("reused");
    expect(observations.at(-1)).toMatchObject({
      phase: "reuse-recheck",
      outcome: "admitted",
      key: "same",
      fence: "same",
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(store.publish).toHaveBeenCalledOnce();
  });

  for (const path of [
    "apps/server/src/.vitest-cache/runtime.ts",
    "node_modules/inert/.vitest-cache/runtime.js",
  ])
    it(`binds genuine source or dependency-owned same-name data at ${path}`, async (context) => {
      const f = await fixture(context);
      await f.put(path, "export const actualInput = 1;\n");
      const before = await f.snapshot();
      expect(before, encode(f.refusals)).toBeDefined();
      await f.put(path, "export const actualInput = 2;\n");
      const after = await f.snapshot();
      expect(after, encode(f.refusals)).toBeDefined();
      expect(after?.key).not.toBe(before?.key);
    });

  it("keeps imports, type programs and ambient roots into omitted output targets ineligible", async (context) => {
    const f = await fixture(context);
    await f.put("build/excluded.ts", "export const excluded = 1;\n");
    await f.put(".explorations/ambient/custom/index.d.ts", "declare const excludedAmbient: 1;\n");
    await f.put(
      "apps/server/src/entry.test.ts",
      'export { excluded } from "../../../build/excluded.ts";\n',
    );
    expect(await f.snapshot()).toBeUndefined();
    await f.put("apps/server/src/entry.test.ts", 'import "./value.ts";\n');
    const task: LocalVerificationTask = {
      ...f.task,
      id: "output-type-refusal",
      cwd: join(f.root, "apps/server"),
      scope: {
        kind: "typecheck",
        workspace: "apps/server",
        compiler: join(f.root, "node_modules/typescript/lib/_tsc.js"),
      },
    };
    await f.put(
      "apps/server/tsconfig.json",
      encode({ extends: "../../tsconfig.base.json", files: ["../../build/excluded.ts"] }),
    );
    expect(await f.fingerprint(task, context.signal)).toBeUndefined();
    await f.put(
      "apps/server/tsconfig.json",
      encode({ extends: "../../tsconfig.base.json", include: ["../../build/**/*.ts"] }),
    );
    expect(await f.fingerprint(task, context.signal)).toBeUndefined();
    // A broad include also selects omitted output children without naming the
    // output prefix itself. Qualification must not rely on the filtered file
    // inventory accidentally making that real compiler program smaller.
    await f.put(
      "apps/server/tsconfig.json",
      encode({ extends: "../../tsconfig.base.json", include: ["../../**/*.ts"] }),
    );
    expect(await f.fingerprint(task, context.signal)).toBeUndefined();
    await f.put(
      "apps/server/tsconfig.json",
      encode({
        extends: "../../tsconfig.base.json",
        include: ["src"],
        compilerOptions: { typeRoots: ["../../.explorations/ambient"] },
      }),
    );
    expect(await f.fingerprint(task, context.signal)).toBeUndefined();
  });

  it("refuses an unexpected relative TypeScript config path even when native resolve would admit it", async (context) => {
    const f = await fixture(context, () => {
      typeScriptOutput.configPath = "";
      typeScriptOutput.configRelative = "";
      typeScriptOutput.configSubstitutions = 0;
    });
    const configPath = await f.put(
      "apps/server/tsconfig.json",
      encode({ extends: "../../tsconfig.base.json", files: ["src/entry.test.ts"] }),
    );
    const relativePath = relativeTypeScriptResult(configPath);
    expect(isAbsolute(relativePath)).toBe(false);
    expect(resolve(relativePath)).toBe(configPath);
    typeScriptOutput.configPath = configPath;
    typeScriptOutput.configRelative = relativePath;
    const task: LocalVerificationTask = {
      ...f.task,
      cwd: join(f.root, "apps/server"),
      scope: {
        kind: "typecheck",
        workspace: "apps/server",
        compiler: join(f.root, "node_modules/typescript/lib/_tsc.js"),
      },
    };
    expect(await f.fingerprint(task, context.signal)).toBeUndefined();
    expect(typeScriptOutput.configSubstitutions).toBe(1);
    expect(f.refusals.at(-1)).toMatchObject({
      reason: "imports",
      detail: { kind: "configuration" },
    });
    expect(f.store.authenticateEnvironment).not.toHaveBeenCalled();
    expect(f.store.read).not.toHaveBeenCalled();
    expect(f.store.publish).not.toHaveBeenCalled();
  });

  it("refuses an unexpected relative TypeScript module result even when native resolve would admit it", async (context) => {
    const f = await fixture(context, () => {
      typeScriptOutput.importer = "";
      typeScriptOutput.modulePath = "";
      typeScriptOutput.moduleRelative = "";
      typeScriptOutput.moduleSubstitutions = 0;
    });
    const modulePath = join(f.root, "apps/server/src/value.ts");
    const relativePath = relativeTypeScriptResult(modulePath);
    expect(isAbsolute(relativePath)).toBe(false);
    expect(resolve(relativePath)).toBe(modulePath);
    typeScriptOutput.importer = join(f.root, "apps/server/src/entry.test.ts");
    typeScriptOutput.modulePath = modulePath;
    typeScriptOutput.moduleRelative = relativePath;
    expect(await f.snapshot()).toBeUndefined();
    expect(typeScriptOutput.moduleSubstitutions).toBe(1);
    expect(f.refusals.at(-1)).toMatchObject({
      reason: "imports",
      detail: { file: "apps/server/src/entry.test.ts", kind: "outside-import" },
    });
    expect(f.store.authenticateEnvironment).not.toHaveBeenCalled();
    expect(f.store.read).not.toHaveBeenCalled();
    expect(f.store.publish).not.toHaveBeenCalled();
  });

  it("refuses a broad workspace type program that reaches its omitted output descendants", async (context) => {
    const f = await fixture(context);
    const serverRoot = join(f.root, "apps/server");
    const configPath = join(serverRoot, "tsconfig.json");
    const narrow = { extends: "../../tsconfig.base.json", include: ["src"] };
    await f.put("apps/server/tsconfig.json", encode(narrow));
    const task: LocalVerificationTask = {
      ...f.task,
      id: "workspace-output-types",
      cwd: serverRoot,
      scope: {
        kind: "typecheck",
        workspace: "apps/server",
        compiler: join(f.root, "node_modules/typescript/lib/_tsc.js"),
      },
    };
    expect(await f.fingerprint(task, context.signal), encode(f.refusals)).toBeDefined();
    const output = await f.put(
      "apps/server/dist/generated.ts",
      "export const actualCompilerInput = 1;\n",
    );
    const broad = { ...narrow, include: ["."] };
    await f.put("apps/server/tsconfig.json", encode(broad));
    // The real public parser sees this file: a filtered inventory must not
    // silently shrink the actual compiler program merely because it is under
    // a customary output name. This config deliberately has no outDir.
    const parsed = ts.parseJsonConfigFileContent(broad, ts.sys, serverRoot, undefined, configPath);
    expect(parsed.errors).toEqual([]);
    expect(parsed.options.outDir).toBeUndefined();
    // TypeScript uses forward slashes on Windows; compare the same absolute
    // native path without granting a relative result the fixture's cwd.
    expect(
      parsed.fileNames.map((fileName) => (isAbsolute(fileName) ? resolve(fileName) : undefined)),
    ).toContain(output);
    expect(await f.fingerprint(task, context.signal)).toBeUndefined();
  });

  it("refuses an ambient type root whose namespace reaches omitted workspace declarations", async (context) => {
    const f = await fixture(context);
    const serverRoot = join(f.root, "apps/server");
    const configPath = join(serverRoot, "tsconfig.json");
    const narrow = { extends: "../../tsconfig.base.json", include: ["src"] };
    await f.put("apps/server/tsconfig.json", encode(narrow));
    const task: LocalVerificationTask = {
      ...f.task,
      id: "workspace-output-ambient-types",
      cwd: serverRoot,
      scope: {
        kind: "typecheck",
        workspace: "apps/server",
        compiler: join(f.root, "node_modules/typescript/lib/_tsc.js"),
      },
    };
    expect(await f.fingerprint(task, context.signal), encode(f.refusals)).toBeDefined();
    const declaration = await f.put(
      "apps/server/dist/index.d.ts",
      "declare const actualAmbientInput: 1;\n",
    );
    const ambient = { ...narrow, compilerOptions: { typeRoots: ["."] } };
    await f.put("apps/server/tsconfig.json", encode(ambient));
    // An ambient package does not need an explicit source import. Qualify the
    // actual parser and resolver against only this fixture's existing files.
    const parsed = ts.parseJsonConfigFileContent(
      ambient,
      ts.sys,
      serverRoot,
      undefined,
      configPath,
    );
    expect(parsed.errors).toEqual([]);
    expect(ts.getAutomaticTypeDirectiveNames(parsed.options, ts.sys)).toContain("dist");
    const resolved = ts.resolveTypeReferenceDirective(
      "dist",
      join(serverRoot, "src/entry.test.ts"),
      parsed.options,
      ts.sys,
    );
    const resolvedFileName = resolved.resolvedTypeReferenceDirective?.resolvedFileName;
    expect(
      resolvedFileName !== undefined && isAbsolute(resolvedFileName)
        ? resolve(resolvedFileName)
        : undefined,
    ).toBe(declaration);
    expect(await f.fingerprint(task, context.signal)).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "refuses a source directory alias exposing omitted output in another workspace",
    async (context) => {
      const f = await fixture(context);
      await f.put("packages/shared/src/readable.txt", "ordinary admitted source bytes\n");
      await f.put("packages/shared/dist/generated.bin", "reachable omitted output bytes\n");
      expect(await f.snapshot(), encode(f.refusals)).toBeDefined();
      // Unlike a repository-root or web alias, this target has no existing
      // router/screenshot/root-output overlap. Its own workspace output role
      // must still prevent treating the filtered linked subtree as complete.
      await f.createFileLink(
        join(f.root, "packages/shared"),
        join(f.root, "apps/server/linked-shared-workspace"),
      );
      expect(await f.snapshot()).toBeUndefined();
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses a source alias exposing output in a workspace-shaped directory without a manifest",
    async (context) => {
      const f = await fixture(context);
      await f.put("packages/extra/src/readable.txt", "ordinary admitted source bytes\n");
      await f.put("packages/extra/dist/generated.bin", "reachable omitted output bytes\n");
      // No package.json exists for this directory. The existing output rule
      // covers its workspace-root shape, so its link/read boundary must use
      // that same role rather than relying only on discovered package names.
      expect(await f.snapshot(), encode(f.refusals)).toBeDefined();
      await f.createFileLink(
        join(f.root, "packages/extra"),
        join(f.root, "apps/server/linked-extra-workspace"),
      );
      expect(await f.snapshot()).toBeUndefined();
    },
  );

  it("refuses effective default and inherited type programs overlapping generated output namespaces", async (context) => {
    const f = await fixture(context);
    await f.put("apps/web/src/components/Known.browser.tsx", "export {};\n");
    const task: LocalVerificationTask = {
      ...f.task,
      id: "effective-output-type-refusal",
      cwd: join(f.root, "apps/web"),
      scope: {
        kind: "typecheck",
        workspace: "apps/web",
        compiler: join(f.root, "node_modules/typescript/lib/_tsc.js"),
      },
    };
    // The default program includes src descendants even before a screenshot
    // is created. A later TypeScript child there cannot be silently omitted.
    expect(await f.fingerprint(task, context.signal)).toBeUndefined();
    await f.put(
      "apps/web/tsconfig.json",
      encode({ extends: "../../tsconfig.base.json", include: ["src"] }),
    );
    await f.put(
      "apps/web/src/components/__screenshots__/Known.browser.tsx/generated.ts",
      "export const outputType = 1;\n",
    );
    expect(await f.fingerprint(task, context.signal)).toBeUndefined();
    // An inherited include is relative to its declaring config, not to the
    // child workspace; the effective public wildcard roots retain that fact.
    await f.put(
      "tsconfig.base.json",
      encode({ compilerOptions: { strict: true }, include: ["**/*"] }),
    );
    await f.put("apps/server/tsconfig.json", encode({ extends: "../../tsconfig.base.json" }));
    const serverTask: LocalVerificationTask = {
      ...task,
      cwd: join(f.root, "apps/server"),
      scope: {
        kind: "typecheck",
        workspace: "apps/server",
        compiler: join(f.root, "node_modules/typescript/lib/_tsc.js"),
      },
    };
    expect(await f.fingerprint(serverTask, context.signal)).toBeUndefined();
    // The same parent default is unused when the real child overrides its
    // program. Do not reject this independent, exact src-only compiler scope.
    await f.put(
      "apps/server/tsconfig.json",
      encode({ extends: "../../tsconfig.base.json", include: ["src"] }),
    );
    expect(await f.fingerprint(serverTask, context.signal), encode(f.refusals)).toBeDefined();
  });

  it.skipIf(process.platform === "win32")(
    "refuses source links into omitted generated output data",
    async (context) => {
      const f = await fixture(context);
      await f.put("build/generated-asset.bin", "inert generated bytes\n");
      await f.createFileLink(
        join(f.root, "build/generated-asset.bin"),
        join(f.root, "apps/server/linked-asset.bin"),
      );
      expect(await f.snapshot()).toBeUndefined();
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses source directory links whose readable subtree includes omitted outputs",
    async (context) => {
      const f = await fixture(context);
      await f.put("build/generated-asset.bin", "inert generated bytes\n");
      expect(await f.snapshot(), encode(f.refusals)).toBeDefined();
      // The target itself is an admitted source directory, but hashing its
      // filtered inventory would not cover this link's readable descendants.
      const link = join(f.root, "apps/server/linked-repository");
      await f.createFileLink(f.root, link);
      expect(await f.snapshot()).toBeUndefined();
      await f.ownPreparation(() => rm(link));
      expect(await f.snapshot(), encode(f.refusals)).toBeDefined();
    },
  );

  it("retains real nested source build data, installed build data and non-test screenshot data", async (context) => {
    const f = await fixture(context);
    const task: LocalVerificationTask = {
      ...f.task,
      scope: { kind: "node", workspace: "scripts" },
    };
    for (const path of [
      "apps/server/src/build/input.txt",
      "node_modules/inert/build/input.txt",
      "apps/web/src/assets/__screenshots__/input.txt",
      "apps/web/.tanstack/source-input.txt",
    ]) {
      await f.put(path, "first genuine input\n");
      const before = await f.fingerprint(task, context.signal);
      expect(before, encode(f.refusals)).toBeDefined();
      await f.put(path, "changed genuine input\n");
      const after = await f.fingerprint(task, context.signal);
      expect(after, encode(f.refusals)).toBeDefined();
      expect(after?.key).not.toBe(before?.key);
    }
  });

  it("binds scoped installed static assets and exact Vite modifiers without accepting unknown queries", async (context) => {
    const f = await fixture(context);
    await f.put(
      "node_modules/@fontsource-variable/dm-sans/package.json",
      encode({ name: "@fontsource-variable/dm-sans", version: "inert" }),
    );
    await f.put(
      "node_modules/@fontsource-variable/dm-sans/files/fixture.woff2",
      "first inert font bytes\n",
    );
    await f.put("node_modules/katex/package.json", encode({ name: "katex", version: "inert" }));
    await f.put("node_modules/katex/dist/fonts/fixture.woff2", "inert math font bytes\n");
    await f.put(
      "apps/server/src/entry.test.ts",
      'import font from "@fontsource-variable/dm-sans/files/fixture.woff2?inline";\nimport math from "katex/dist/fonts/fixture.woff2?url";\nexport { font, math };\n',
    );
    const first = await f.snapshot();
    expect(first, encode(f.refusals)).toBeDefined();
    await f.put(
      "node_modules/@fontsource-variable/dm-sans/files/fixture.woff2",
      "changed inert font bytes\n",
    );
    expect((await f.snapshot())?.key).not.toBe(first?.key);
    await f.put(
      "apps/server/src/entry.test.ts",
      'import font from "@fontsource-variable/dm-sans/files/fixture.woff2?unqualified";\nexport { font };\n',
    );
    expect(await f.snapshot()).toBeUndefined();
  });

  it("binds unimported cross-workspace ambient type roots and refuses excluded or external roots", async (context) => {
    const f = await fixture(context);
    await f.put("apps/web/ambient/custom/index.d.ts", "declare const ambientValue: 1;\n");
    const configure = (typeRoot: string) =>
      f.put(
        "apps/server/tsconfig.json",
        encode({
          extends: "../../tsconfig.base.json",
          compilerOptions: { typeRoots: [typeRoot] },
          include: ["src"],
        }),
      );
    await configure("../web/ambient");
    const task: LocalVerificationTask = {
      ...f.task,
      id: "ambient-types",
      cwd: join(f.root, "apps/server"),
      scope: {
        kind: "typecheck",
        workspace: "apps/server",
        compiler: join(f.root, "node_modules/typescript/lib/_tsc.js"),
      },
    };
    const first = await f.fingerprint(task, context.signal);
    expect(first, encode(f.refusals)).toBeDefined();
    await f.put("apps/web/ambient/custom/index.d.ts", "declare const ambientValue: 2;\n");
    expect((await f.fingerprint(task, context.signal))?.key).not.toBe(first?.key);
    // An admitted ambient root can still reach an omitted descendant. The
    // real server src program does not overlap it through its own include.
    await f.put("apps/web/src/components/Known.browser.tsx", "export {};\n");
    await f.put(
      "apps/web/src/components/__screenshots__/custom/index.d.ts",
      "declare const omittedAmbient: 1;\n",
    );
    await configure("../web/src/components");
    expect(await f.fingerprint(task, context.signal)).toBeUndefined();
    await f.put(".plans/ambient/custom/index.d.ts", "inert excluded declaration\n");
    await configure("../../.plans/ambient");
    expect(await f.fingerprint(task, context.signal)).toBeUndefined();
    await configure(tmpdir());
    expect(await f.fingerprint(task, context.signal)).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "binds admitted source-link data and refuses excluded private link targets",
    async (context) => {
      const f = await fixture(context);
      await f.put("apps/web/public/fixture.bin", "first inert asset\n");
      await f.createFileLink(
        join(f.root, "apps/web/public/fixture.bin"),
        join(f.root, "apps/server/asset.bin"),
      );
      const first = await f.snapshot();
      expect(first, encode(f.refusals)).toBeDefined();
      await f.put("apps/web/public/fixture.bin", "changed inert asset\n");
      expect((await f.snapshot())?.key).not.toBe(first?.key);
      await f.put(".plans/private-fixture", "inert deliberately excluded bytes\n");
      await f.createFileLink(
        join(f.root, ".plans/private-fixture"),
        join(f.root, "apps/server/excluded.bin"),
      );
      expect(await f.snapshot()).toBeUndefined();
    },
  );

  it("binds a cross-workspace runtime export even when TypeScript selects its declaration", async (context) => {
    const f = await fixture(context);
    await f.put("apps/web/src/api.d.ts", "export declare const value: number;\n");
    await f.put("apps/web/src/api.js", "export const value = 1;\n");
    await f.put(
      "apps/server/src/entry.test.ts",
      'import { value } from "../../web/src/api.js";\nexport { value };\n',
    );
    const first = await f.snapshot();
    expect(first, encode(f.refusals)).toBeDefined();
    await f.put("apps/web/src/api.js", "export const value = 2;\n");
    expect((await f.snapshot())?.key).not.toBe(first?.key);
    await f.put(
      "apps/web/package.json",
      encode({
        name: "@cafecode/web",
        exports: { ".": { types: "./src/api.d.ts", default: "./*/runtime.js" } },
      }),
    );
    expect(await f.snapshot()).toBeUndefined();
    await f.put(
      "apps/web/package.json",
      encode({
        name: "@cafecode/web",
        exports: { ".": { types: "./src/api.d.ts", default: "./dist/runtime.js" } },
      }),
    );
    expect(await f.snapshot()).toBeUndefined();
  });

  it("binds actual workspace-local shadow dependencies and their installed bytes", async (context) => {
    const f = await fixture(context);
    await f.put("apps/server/src/entry.test.ts", 'import "inert";\n');
    const hoisted = await f.snapshot();
    expect(hoisted, encode(f.refusals)).toBeDefined();
    await f.put(
      "apps/server/node_modules/inert/package.json",
      encode({ name: "inert", version: "1.0.0", exports: "./index.js" }),
    );
    await f.put("apps/server/node_modules/inert/index.js", "export const shadow = 1;\n");
    const shadow = await f.snapshot();
    expect(shadow, encode(f.refusals)).toBeDefined();
    expect(shadow?.key).not.toBe(hoisted?.key);
    // The real local package must resolve, not a guessed hoisted fallback.
    await f.put(
      "node_modules/inert/package.json",
      encode({ name: "inert", version: "1.0.0", exports: "./missing.js" }),
    );
    const rebound = await f.snapshot();
    expect(rebound, encode(f.refusals)).toBeDefined();
    await f.put("apps/server/node_modules/inert/index.js", "export const shadow = 2;\n");
    expect((await f.snapshot())?.key).not.toBe(rebound?.key);
  });

  it("ignores only declared generated output names while retaining relevant membership", async (context) => {
    const f = await fixture(context);
    const first = await f.snapshot();
    expect(first, encode(f.refusals)).toBeDefined();
    await f.put("apps/server/tsconfig.tsbuildinfo", "inert generated metadata\n");
    await f.put("apps/server/.typecheck-retirement-ABC123/metadata", "inert held output\n");
    await f.put("node_modules/.vite-temp/generated", "inert generated output\n");
    expect(await f.snapshot(), encode(f.refusals)).toEqual(first);
    await f.put(
      "apps/server/src/.typecheck-retirement-ABC123/not-an-output.ts",
      "export const genuine = 1;\n",
    );
    expect((await f.snapshot())?.key).not.toBe(first?.key);
  });

  it.skipIf(process.platform === "win32")(
    "refuses a non-executable PATH shadow instead of attesting the wrong executable",
    async (context) => {
      const f = await fixture(context);
      await f.put("tools/path-shadow/git", "#!/bin/sh\nexit 0\n");
      const task: LocalVerificationTask = {
        ...f.task,
        environment: {
          ...f.task.environment,
          PATH: [join(f.root, "tools/path-shadow"), f.task.environment.PATH].join(delimiter),
        },
      };
      expect(await f.fingerprint(task, context.signal)).toBeUndefined();
      // Root can execute a file when any execute bit is set; retain this
      // owner-specific negative only for ordinary non-root native execution.
      if (process.getuid?.() !== 0) {
        await f.ownPreparation(() => chmod(join(f.root, "tools/path-shadow/git"), 0o601));
        expect(await f.fingerprint(task, context.signal)).toBeUndefined();
      }
      await f.ownPreparation(() => chmod(join(f.root, "tools/path-shadow/git"), 0o700));
      expect(await f.fingerprint(task, context.signal), encode(f.refusals)).toBeDefined();
    },
  );

  it("reuses identical bytes but separates native edits from reusable content", async (context) => {
    const f = await fixture(context);
    const first = await f.snapshot();
    expect(first, encode(f.refusals)).toBeDefined();
    expect(await f.snapshot()).toEqual(first);
    const path = join(f.root, "apps/server/src/value.ts");
    const same = await f.ownPreparation(() => readFile(path));
    await f.ownPreparation(() => writeFile(path, same));
    const second = await f.snapshot();
    expect(second?.key).toBe(first?.key);
    expect(second?.fence).not.toBe(first?.fence);
    expect(f.store.read).not.toHaveBeenCalled();
    expect(f.store.publish).not.toHaveBeenCalled();
  });

  it("keys server additions and deletion without invalidating for unrelated browser bodies", async (context) => {
    const f = await fixture(context);
    const first = await f.snapshot();
    expect(first).toBeDefined();
    await f.put("apps/web/src/unused.browser.tsx", "export const unrelatedBrowserCase = 2;\n");
    const unrelated = await f.snapshot();
    expect(unrelated, encode(f.refusals)).toBeDefined();
    expect(unrelated?.key).toBe(first?.key);
    await f.put("apps/server/src/new-untracked.ts", "export const newInput = 1;\n");
    const added = await f.snapshot();
    expect(added, encode(f.refusals)).toBeDefined();
    expect(added?.key).not.toBe(first?.key);
    await f.ownPreparation(() => rm(join(f.root, "apps/server/src/new-untracked.ts")));
    const deleted = await f.snapshot();
    expect(deleted, encode(f.refusals)).toBeDefined();
    expect(deleted?.key).toBe(first?.key);
  });

  it("keys installed package bytes and reviewed cross-root data", async (context) => {
    const f = await fixture(context);
    const first = await f.snapshot();
    expect(first, encode(f.refusals)).toBeDefined();
    await f.put("node_modules/inert/index.js", "export const dependency = 2;\n");
    const dependency = await f.snapshot();
    expect(dependency, encode(f.refusals)).toBeDefined();
    expect(dependency?.key).not.toBe(first?.key);
    await f.put("apps/web/src/index.css", "body { color: blue; }\n");
    const crossRoot = await f.snapshot();
    expect(crossRoot, encode(f.refusals)).toBeDefined();
    expect(crossRoot?.key).not.toBe(dependency?.key);
  });

  it("keys exact command and environment inputs against stationary source", async (context) => {
    const f = await fixture(context);
    const first = await f.snapshot();
    expect(first, encode(f.refusals)).toBeDefined();
    // No source/tool inputs change after this admitted baseline. Reuse the
    // same observed baseline for the two isolated task-input comparisons.
    const command = await f.fingerprint(
      { ...f.task, args: [...f.task.args, "different"] },
      context.signal,
    );
    expect(command, encode(f.refusals)).toBeDefined();
    expect(command?.key).not.toBe(first?.key);
    const environment = await f.fingerprint(
      { ...f.task, environment: { ...f.task.environment, SYNTHETIC_INPUT: "changed" } },
      context.signal,
    );
    expect(environment, encode(f.refusals)).toBeDefined();
    expect(environment?.key).not.toBe(first?.key);
  });

  it("keys the actual prepared tracing-free environment while retaining every unrelated input", async (context) => {
    const f = await fixture(context);
    const firstTask = {
      ...f.task,
      environment: {
        ...f.task.environment,
        CODEX_TOOL_CALL_ID: "synthetic-first-caller",
        SYNTHETIC_INPUT: "unchanged-input",
      },
    };
    const secondTask = {
      ...firstTask,
      environment: { ...firstTask.environment, CODEX_TOOL_CALL_ID: "synthetic-second-caller" },
    };
    const prepare = (task: LocalVerificationTask): LocalVerificationTask => ({
      ...task,
      environment: prepareLocalVerificationTaskEnvironment(task, true, "linux"),
    });
    // These remain three real native inventories over stationary source/tool
    // bytes. Only the actual child environment is prepared; the producer never
    // ignores a field that an executor would still receive.
    const first = await f.fingerprint(prepare(firstTask), context.signal);
    expect(first, encode(f.refusals)).toBeDefined();
    const second = await f.fingerprint(prepare(secondTask), context.signal);
    expect(second, encode(f.refusals)).toBeDefined();
    expect(second?.key).toBe(first?.key);
    const changed = await f.fingerprint(
      prepare({
        ...secondTask,
        environment: { ...secondTask.environment, SYNTHETIC_INPUT: "changed-input" },
      }),
      context.signal,
    );
    expect(changed, encode(f.refusals)).toBeDefined();
    expect(changed?.key).not.toBe(first?.key);
    expect(firstTask.environment.CODEX_TOOL_CALL_ID).toBe("synthetic-first-caller");
    expect(secondTask.environment.CODEX_TOOL_CALL_ID).toBe("synthetic-second-caller");
    expect(f.store.authenticateEnvironment).toHaveBeenCalledTimes(3);
  });

  it("shares validated tool digests between real producers but still observes changed source", async (context) => {
    const f = await selectedToolFixture(context);
    const first = await f.snapshot();
    expect(first, encode(f.refusals)).toBeDefined();
    const firstOpens = selectedTool.opens;
    expect(firstOpens).toBeGreaterThan(0);
    const second = await f.snapshot();
    expect(second, encode(f.refusals)).toEqual(first);
    expect(selectedTool.opens).toBe(firstOpens);
    await f.put("apps/server/src/value.ts", "export const value = 2;\n");
    const sourceChanged = await f.snapshot();
    expect(sourceChanged, encode(f.refusals)).toBeDefined();
    expect(sourceChanged?.key).not.toBe(first?.key);
    expect(selectedTool.opens).toBe(firstOpens);
  });

  it("rereads changed selected-tool bytes even when length and native mtime are restored", async (context) => {
    const f = await selectedToolFixture(context);
    const first = await f.snapshot();
    expect(first, encode(f.refusals)).toBeDefined();
    const firstOpens = selectedTool.opens;
    const before = await f.ownPreparation(() => lstat(f.path, { bigint: true }));
    const changedBytes = "#!/bin/sh\nexit 1\n";
    expect(Buffer.byteLength(changedBytes)).toBe(Buffer.byteLength(f.toolBytes));
    await f.ownPreparation(() => writeFile(f.path, changedBytes));
    await f.ownPreparation(() => utimes(f.path, before.atime, before.mtime));
    const after = await f.ownPreparation(() => lstat(f.path, { bigint: true }));
    expect(after.size).toBe(before.size);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(after.ctimeNs).not.toBe(before.ctimeNs);
    const changed = await f.snapshot();
    expect(changed, encode(f.refusals)).toBeDefined();
    expect(changed?.key).not.toBe(first?.key);
    expect(selectedTool.opens).toBeGreaterThan(firstOpens);
  });

  it.skipIf(process.platform === "win32")(
    "rereads a selected tool after its mode changes while native execute admission remains valid",
    async (context) => {
      const f = await selectedToolFixture(context);
      const first = await f.snapshot();
      expect(first, encode(f.refusals)).toBeDefined();
      const firstOpens = selectedTool.opens;
      const before = await f.ownPreparation(() => lstat(f.path, { bigint: true }));
      await f.ownPreparation(() => chmod(f.path, 0o500));
      const after = await f.ownPreparation(() => lstat(f.path, { bigint: true }));
      expect(after.mode).not.toBe(before.mode);
      expect(after.mode & 0o111n).not.toBe(0n);
      const changed = await f.snapshot();
      expect(changed, encode(f.refusals)).toBeDefined();
      expect(changed?.key).not.toBe(first?.key);
      expect(selectedTool.opens).toBeGreaterThan(firstOpens);
    },
  );

  it("rereads an actual replacement inode at the same selected-tool path", async (context) => {
    const f = await selectedToolFixture(context);
    const first = await f.snapshot();
    expect(first, encode(f.refusals)).toBeDefined();
    const firstOpens = selectedTool.opens;
    const before = await f.ownPreparation(() => lstat(f.path, { bigint: true }));
    // Keep bytes, mode and mtime identical so only the native replacement
    // identity can require another read; reusable semantic content stays equal.
    const replacement = await f.put("tools/replacement-git", f.toolBytes);
    await f.ownPreparation(() => chmod(replacement, 0o700));
    await f.ownPreparation(() => utimes(replacement, before.atime, before.mtime));
    await f.ownPreparation(() => rename(replacement, f.path));
    const after = await f.ownPreparation(() => lstat(f.path, { bigint: true }));
    expect([after.dev, after.ino]).not.toEqual([before.dev, before.ino]);
    const changed = await f.snapshot();
    expect(changed, encode(f.refusals)).toBeDefined();
    expect(changed?.key).toBe(first?.key);
    expect(changed?.fence).not.toBe(first?.fence);
    expect(selectedTool.opens).toBeGreaterThan(firstOpens);
  });

  it("does not remember a tool digest when its exact native open failed", async (context) => {
    const f = await selectedToolFixture(context);
    selectedTool.failNextOpen = true;
    expect(await f.snapshot()).toBeUndefined();
    expect(f.refusals.at(-1)?.reason).toBe("tools");
    expect(selectedTool.failNextOpen).toBe(false);
    const refusedOpens = selectedTool.opens;
    expect(refusedOpens).toBeGreaterThan(0);
    expect(f.store.authenticateEnvironment).not.toHaveBeenCalled();
    const admitted = await f.snapshot();
    expect(admitted, encode(f.refusals)).toBeDefined();
    expect(selectedTool.opens).toBeGreaterThan(refusedOpens);
    expect(f.store.read).not.toHaveBeenCalled();
    expect(f.store.publish).not.toHaveBeenCalled();
  });

  it("retains valid tool bytes after unrelated input refusal without granting task-success authority", async (context) => {
    const f = await selectedToolFixture(context);
    const refusedStore: LocalVerificationReceiptStore = {
      ...f.store,
      authenticateEnvironment: vi.fn(() => {
        throw Object.freeze({ synthetic: "late authentication refusal" });
      }),
    };
    expect(await f.snapshot(refusedStore)).toBeUndefined();
    expect(refusedStore.authenticateEnvironment).toHaveBeenCalledOnce();
    const validatedOpens = selectedTool.opens;
    expect(validatedOpens).toBeGreaterThan(0);
    const admitted = await f.snapshot();
    expect(admitted, encode(f.refusals)).toBeDefined();
    expect(selectedTool.opens).toBe(validatedOpens);
    expect(f.store.read).not.toHaveBeenCalled();
    expect(f.store.publish).not.toHaveBeenCalled();
  });

  it("resolves a real new cross-workspace import and binds its current bytes", async (context) => {
    const f = await fixture(context);
    await f.put("apps/web/src/imported.ts", "export const imported = 1;\n");
    await f.put(
      "apps/server/src/value.ts",
      'export { imported } from "../../web/src/imported.ts";\n',
    );
    const first = await f.snapshot();
    expect(first).toBeDefined();
    await f.put("apps/web/src/imported.ts", "export const imported = 2;\n");
    expect((await f.snapshot())?.key).not.toBe(first?.key);
  });

  it("covers actual inherited type config and direct and transitive outside include data", async (context) => {
    const f = await fixture(context);
    await f.put(
      "apps/server/tsconfig.json",
      encode({ extends: "../../tsconfig.base.json", include: ["src", "../web/src/imported.ts"] }),
    );
    await f.put("apps/web/src/imported.ts", "export const imported = 1;\n");
    const task: LocalVerificationTask = {
      ...f.task,
      id: "server-types",
      cwd: join(f.root, "apps/server"),
      scope: {
        kind: "typecheck",
        workspace: "apps/server",
        compiler: join(f.root, "node_modules/typescript/lib/_tsc.js"),
      },
    };
    const first = await f.fingerprint(task, context.signal);
    expect(first).toBeDefined();
    await f.put("apps/web/src/imported.ts", "export const imported = 2;\n");
    const changed = await f.fingerprint(task, context.signal);
    expect(changed, encode(f.refusals)).toBeDefined();
    expect(changed?.key).not.toBe(first?.key);
    await f.put("apps/web/src/dependency.ts", "export const dependency = 1;\n");
    await f.put("apps/web/src/imported.ts", 'export { dependency } from "./dependency.ts";\n');
    const transitive = await f.fingerprint(task, context.signal);
    expect(transitive).toBeDefined();
    await f.put("apps/web/src/dependency.ts", "export const dependency = 2;\n");
    const dependency = await f.fingerprint(task, context.signal);
    expect(dependency, encode(f.refusals)).toBeDefined();
    expect(dependency?.key).not.toBe(transitive?.key);
  });

  it("binds actual selected compiler bytes and refuses another compiler path", async (context) => {
    const f = await fixture(context);
    await f.put(
      "apps/server/tsconfig.json",
      encode({ extends: "../../tsconfig.base.json", include: ["src", "../web/src/imported.ts"] }),
    );
    await f.put("apps/web/src/imported.ts", "export const imported = 1;\n");
    const task: LocalVerificationTask = {
      ...f.task,
      id: "server-types",
      cwd: join(f.root, "apps/server"),
      scope: {
        kind: "typecheck",
        workspace: "apps/server",
        compiler: join(f.root, "node_modules/typescript/lib/_tsc.js"),
      },
    };
    const first = await f.fingerprint(task, context.signal);
    expect(first, encode(f.refusals)).toBeDefined();
    // Every source/config input stays stationary across the compiler edit, so
    // an unrelated preceding source change cannot satisfy this byte control.
    await f.put("node_modules/typescript/lib/_tsc.js", "// changed exact compiler\n");
    const changed = await f.fingerprint(task, context.signal);
    expect(changed, encode(f.refusals)).toBeDefined();
    expect(changed?.key).not.toBe(first?.key);
    expect(
      await f.fingerprint(
        {
          ...task,
          scope: {
            kind: "typecheck",
            workspace: "apps/server",
            compiler: join(f.root, "tools/yarn.cjs"),
          },
        },
        context.signal,
      ),
    ).toBeUndefined();
  });

  for (const [field, entry] of [
    ["npm_execpath", "yarn"],
    ["npm_node_execpath", "node"],
  ] as const)
    it.skipIf(process.platform === "win32")(
      `normalizes the exact qualified Yarn ${field} entry without changing other task inputs`,
      async (context) => {
        const f = await yarnPathFixture(context);
        const first = await f.snapshot();
        expect(first, encode(f.refusals)).toBeDefined();
        // BERRY_BIN_FOLDER, both PATH components, every other environment
        // field and all source/tool payloads stay stationary. A different
        // native pathname/fence is allowed, but not a different content key.
        const second = await f.snapshot({ [field]: join(f.two, entry) });
        expect(second, encode(f.refusals)).toBeDefined();
        expect(second?.key).toBe(first?.key);
      },
    );

  it.skipIf(process.platform === "win32")(
    "does not normalize an external symlink merely because its target is a qualified Yarn entry",
    async (context) => {
      const f = await yarnPathFixture(context);
      const alias = join(f.root, "tools/external-yarn");
      await f.createFileLink(join(f.one, "yarn"), alias);
      // Admit the alias before both observations so changing only npm_execpath
      // cannot be confused with adding a source link or changing wrapper bytes.
      const first = await f.snapshot();
      expect(first, encode(f.refusals)).toBeDefined();
      const aliased = await f.snapshot({ npm_execpath: alias });
      // A safe refusal is also valid; realpath equality alone must never mint
      // the exact qualified directory-entry normalization authority.
      expect(aliased?.key).not.toBe(first?.key);
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps the qualified node entry distinct from the qualified yarn npm executable",
    async (context) => {
      const phases = observeYarnInputPhases(context, "entry-name");
      phases.mark("fixture-entered");
      const f = await yarnPathFixture(context, phases.ownedClosed, phases.mark);
      phases.bindRefusals(f.refusals);
      phases.mark("fixture-ready");
      phases.mark("snapshot-entered", 1);
      const first = await f.snapshot();
      phases.mark("snapshot-settled", 1);
      expect(first, encode(f.refusals)).toBeDefined();
      phases.mark("snapshot-entered", 2);
      const nodeEntry = await f.snapshot({ npm_execpath: join(f.one, "node") });
      phases.mark("snapshot-settled", 2);
      // Directory content identity does not erase the selected entry name or
      // authorize a node forwarding script to stand in for the yarn entry.
      expect(nodeEntry?.key).not.toBe(first?.key);
    },
  );

  for (const [entry, argument] of [
    ["node", "--no-warnings"],
    ["yarn", "run"],
  ] as const)
    it.skipIf(process.platform === "win32")(
      `binds changed literal arguments in the qualified ${entry} forwarder`,
      async (context) => {
        const f = await yarnPathFixture(context);
        const first = await f.snapshot();
        expect(first, encode(f.refusals)).toBeDefined();
        await f.put(`tools/xfs-11111111/${entry}`, f[entry].replace('"$@"', `'${argument}' "$@"`));
        // Keep the selected pathname identical so a raw-path difference
        // cannot satisfy this control instead of the changed forwarding bytes.
        const changed = await f.snapshot();
        expect(changed, encode(f.refusals)).toBeDefined();
        expect(changed?.key).not.toBe(first?.key);
      },
    );

  it.skipIf(process.platform === "win32")(
    "binds the actual qualified Yarn forwarder's executable mode",
    async (context) => {
      const phases = observeYarnInputPhases(context, "executable-mode");
      phases.mark("fixture-entered");
      const f = await yarnPathFixture(context, phases.ownedClosed, phases.mark);
      phases.bindRefusals(f.refusals);
      phases.mark("fixture-ready");
      phases.mark("snapshot-entered", 1);
      const first = await f.snapshot();
      phases.mark("snapshot-settled", 1);
      expect(first, encode(f.refusals)).toBeDefined();
      phases.mark("mutation-entered");
      await f.ownPreparation(() => chmod(join(f.one, "yarn"), 0o755));
      phases.mark("mutation-settled");
      phases.mark("snapshot-entered", 2);
      const changed = await f.snapshot();
      phases.mark("snapshot-settled", 2);
      expect(changed, encode(f.refusals)).toBeDefined();
      expect(changed?.key).not.toBe(first?.key);
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses self-path-dependent forwarding rather than normalizing its Yarn metadata",
    async (context) => {
      const f = await yarnPathFixture(context);
      expect(await f.snapshot(), encode(f.refusals)).toBeDefined();
      await f.put("tools/xfs-11111111/node", '#!/bin/sh\nexec "$(dirname "$0")/node" "$@"\n');
      expect(await f.snapshot()).toBeUndefined();
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses a missing npm executable entry instead of deriving authority from its shim directory",
    async (context) => {
      const f = await yarnPathFixture(context);
      expect(await f.snapshot(), encode(f.refusals)).toBeDefined();
      expect(await f.snapshot({ npm_execpath: join(f.one, "missing-yarn") })).toBeUndefined();
    },
  );

  for (const field of ["npm_lifecycle_event", "npm_lifecycle_script", "INIT_CWD"] as const)
    it.skipIf(process.platform === "win32")(
      `preserves literal ${field} identity while normalizing only qualified Yarn entry paths`,
      async (context) => {
        const f = await yarnPathFixture(context);
        const first = await f.snapshot();
        expect(first, encode(f.refusals)).toBeDefined();
        const changed = await f.snapshot({ [field]: "synthetic-changed-environment-input" });
        expect(changed, encode(f.refusals)).toBeDefined();
        expect(changed?.key).not.toBe(first?.key);
      },
    );

  it.skipIf(process.platform === "win32")(
    "normalizes only the complete private Yarn shim identity and preserves every other environment input",
    async (context) => {
      const f = await fixture(context);
      const shim = (name: string, contents = `#!/bin/sh\nexec "${process.execPath}"  "$@"\n`) =>
        // Own the dependent chain as well as each native step. A timeout
        // during mkdir cannot resume an unowned write after root retirement.
        f.ownPreparation(async () => {
          const path = join(f.root, "tools", name);
          await f.ownPreparation(() => mkdir(path, { mode: 0o700 }));
          await f.ownPreparation(() => writeFile(join(path, "node"), contents, { mode: 0o700 }));
          return path;
        });
      const one = await shim("xfs-11111111");
      const two = await shim("xfs-22222222");
      const nestedContents = `#!/bin/sh\nexec "${process.execPath}" '${join(f.root, "tools/corepack/dist/yarn.js")}' 'run' "$@"\n`;
      const nestedOne = await shim("xfs-33333333", nestedContents);
      const nestedTwo = await shim("xfs-44444444", nestedContents);
      const run = (path: string) =>
        f.fingerprint(
          {
            ...f.task,
            environment: {
              ...f.task.environment,
              BERRY_BIN_FOLDER: path,
              PATH: [path, f.task.environment.PATH].join(delimiter),
            },
          },
          context.signal,
        );
      const first = await run(one);
      expect(first).toBeDefined();
      expect((await run(two))?.key).toBe(first?.key);
      await f.ownPreparation(() => chmod(two, 0o755));
      const publicForwarders = await run(two);
      expect(publicForwarders, encode(f.refusals)).toBeDefined();
      expect(publicForwarders?.key).toBe(first?.key);
      const nested = (outer: string, inner: string) =>
        f.fingerprint(
          {
            ...f.task,
            environment: {
              ...f.task.environment,
              BERRY_BIN_FOLDER: outer,
              PATH: [outer, inner, f.task.environment.PATH].join(delimiter),
            },
          },
          context.signal,
        );
      const nestedFirst = await nested(one, nestedOne);
      expect(nestedFirst).toBeDefined();
      expect((await nested(two, nestedTwo))?.key).toBe(nestedFirst?.key);
      await f.ownPreparation(() =>
        writeFile(
          join(two, "node"),
          `#!/bin/sh\nexec "${process.execPath}" 'changed-literal-argument' "$@"\n`,
        ),
      );
      expect((await run(two))?.key).not.toBe(first?.key);
      await f.ownPreparation(() =>
        writeFile(join(two, "node"), '#!/bin/sh\nexec "$(dirname "$0")/node" "$@"\n'),
      );
      expect(await run(two)).toBeUndefined();
      await f.ownPreparation(() => chmod(two, 0o755));
      expect(await run(two)).toBeUndefined();
    },
  );

  it("refuses aliases, unknown workspaces, loader hooks and retired observations without opening private environment files", async (context) => {
    const f = await fixture(context);
    expect(
      await f.fingerprint(
        { ...f.task, scope: { kind: "node", workspace: "unreviewed" } },
        context.signal,
      ),
    ).toBeUndefined();
    expect(
      await f.fingerprint(
        {
          ...f.task,
          environment: { ...f.task.environment, NODE_OPTIONS: "--import=unreviewed.mjs" },
        },
        context.signal,
      ),
    ).toBeUndefined();
    const abort = new AbortController();
    abort.abort();
    expect(await f.fingerprint(f.task, abort.signal)).toBeUndefined();
    await f.put(".env", "synthetic secret never authenticated\n");
    f.store.authenticateEnvironment.mockClear();
    expect(await f.snapshot()).toBeUndefined();
    expect(f.store.authenticateEnvironment).not.toHaveBeenCalled();
    await f.ownPreparation(() => rm(join(f.root, ".env")));
    await f.ownPreparation(() =>
      symlink(
        tmpdir(),
        join(f.root, "apps/server/outside"),
        process.platform === "win32" ? "junction" : "dir",
      ),
    );
    expect(await f.snapshot()).toBeUndefined();
  });

  it("binds scripts' repository-wide read contract rather than only their imports", async (context) => {
    const f = await fixture(context);
    const task: LocalVerificationTask = {
      ...f.task,
      scope: { kind: "node", workspace: "scripts" },
    };
    const first = await f.fingerprint(task, context.signal);
    expect(first).toBeDefined();
    await f.put("apps/web/src/unused.browser.tsx", "export const unrelatedBrowserCase = 3;\n");
    expect((await f.fingerprint(task, context.signal))?.key).not.toBe(first?.key);
    // Touch is not reusable content, but must retire the execution publication
    // fence even when the source bytes are unchanged.
    const path = join(f.root, "apps/server/src/value.ts");
    await f.ownPreparation(() => utimes(path, 1, 1));
    expect((await f.fingerprint(task, context.signal))?.fence).not.toBe(first?.fence);
  });
});
