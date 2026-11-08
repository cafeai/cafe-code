// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import {
  chmod as chmodFile,
  copyFile,
  link as createHardLink,
  lstat,
  readFile,
  rename,
  rm,
  stat as statFile,
  symlink as createNodeSymlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { ProviderDriverKind, type CodexSettings } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as PlatformError from "effect/PlatformError";

import { expandHomePath } from "../../pathExpansion.ts";
import { isNewerRenewalOfSameCodexLogin } from "../codexAuthJson.ts";

export interface CodexHomeLayout {
  readonly mode: "direct" | "authOverlay";
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string | undefined;
  readonly continuationKey: string;
}

export type CodexShadowHomeAuthSource = "shared" | "shadow";

/** Login must write to the source used by subsequent auth-overlay refreshes. */
export function codexLoginHomePath(
  layout: CodexHomeLayout,
  authSource: CodexShadowHomeAuthSource,
): string {
  return authSource === "shadow"
    ? (layout.effectiveHomePath ?? layout.sharedHomePath)
    : layout.sharedHomePath;
}

const KNOWN_SHARED_DIRECTORIES = [
  "sessions",
  "archived_sessions",
  "ambient-suggestions",
  "sqlite",
  "shell_snapshots",
  "worktrees",
  "skills",
  "plugins",
  "cache",
  "computer-use",
  "logs",
  "pets",
  "rules",
  "vendor_imports",
] as const;

const KNOWN_SHARED_FILES = [
  ".codex-global-state.json",
  ".codex-global-state.json.bak",
  ".personality_migration",
  "AGENTS.md",
  "config.toml",
  "history.jsonl",
  "installation_id",
  "managed_config.toml",
  "session_index.jsonl",
  "version.json",
] as const;

const KNOWN_SHARED_DIRECTORY_NAMES = new Set<string>(KNOWN_SHARED_DIRECTORIES);
const PRIVATE_ENTRY_NAMES = new Set(["auth.json", "models_cache.json"]);
const SHADOW_LOCAL_ENTRY_NAMES = new Set([".tmp", "log", "memories", "tmp"]);
const KNOWN_SHARED_ENTRY_NAMES = new Set<string>([
  ...KNOWN_SHARED_DIRECTORIES,
  ...KNOWN_SHARED_FILES,
]);
const CODEX_RUNTIME_SQLITE_ENTRY_REGEX =
  /^[^/]+(?:\.sqlite|\.sqlite3|\.db)(?:-(?:wal|shm|journal))?$/;

export function isCodexShadowLocalEntryName(entryName: string): boolean {
  return (
    SHADOW_LOCAL_ENTRY_NAMES.has(entryName) || CODEX_RUNTIME_SQLITE_ENTRY_REGEX.test(entryName)
  );
}

export function shouldShareCodexShadowEntryName(entryName: string): boolean {
  return (
    KNOWN_SHARED_ENTRY_NAMES.has(entryName) &&
    !PRIVATE_ENTRY_NAMES.has(entryName) &&
    !isCodexShadowLocalEntryName(entryName)
  );
}

function resolveHomePath(path: Path.Path, value: string | undefined): string {
  const expanded =
    value && value.trim().length > 0
      ? expandHomePath(value)
      : path.join(NodeOS.homedir(), ".codex");
  return path.resolve(expanded);
}

export const resolveCodexHomeLayout = Effect.fn("resolveCodexHomeLayout")(function* (
  config: CodexSettings,
): Effect.fn.Return<CodexHomeLayout, never, Path.Path> {
  const path = yield* Path.Path;
  const sharedHomePath = resolveHomePath(path, config.homePath);
  const shadowHomePath = config.shadowHomePath.trim();
  if (shadowHomePath.length === 0) {
    return {
      mode: "direct",
      sharedHomePath,
      effectiveHomePath: config.homePath.trim().length > 0 ? sharedHomePath : undefined,
      continuationKey: `codex:home:${sharedHomePath}`,
    };
  }

  const effectiveHomePath = path.resolve(expandHomePath(shadowHomePath));
  return {
    mode: "authOverlay",
    sharedHomePath,
    effectiveHomePath,
    continuationKey: `codex:home:${sharedHomePath}`,
  };
});

/**
 * Keep the SQLite history projection beside the canonical shared rollouts.
 *
 * An auth overlay changes CODEX_HOME to isolate credentials, but its sessions
 * still belong to sharedHomePath. Letting upstream also default SQLite to that
 * overlay can leave one database marking a migrated rollout as legacy while
 * another marks it as paginated. Codex then rejects the same thread's resume
 * cursor with `list_turns is not supported yet` even though pagination exists.
 *
 * Codex rust-v0.153.4 (3d2ee51), state/src/lib.rs and core/src/config/mod.rs,
 * defines CODEX_SQLITE_HOME and resolves sqlite_home config > nonblank env >
 * CODEX_HOME. Supply only the missing environment default: explicit upstream
 * config and caller environment remain authoritative. This never copies,
 * links, rewrites, or removes a database, nor does it change the auth home.
 */
export function withCodexHomeLayoutEnvironment(
  layout: CodexHomeLayout,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (layout.mode !== "authOverlay" || environment.CODEX_SQLITE_HOME?.trim()) {
    return environment;
  }
  return { ...environment, CODEX_SQLITE_HOME: layout.sharedHomePath };
}

export class CodexShadowHomeError extends Schema.TaggedErrorClass<CodexShadowHomeError>()(
  "CodexShadowHomeError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {
  override get message(): string {
    return this.detail;
  }
}
const isCodexShadowHomeError = Schema.is(CodexShadowHomeError);

type LinkState =
  | {
      readonly _tag: "Missing";
    }
  | {
      readonly _tag: "NotSymlink";
    }
  | {
      readonly _tag: "Symlink";
      readonly target: string;
    };

function toShadowHomeError(cause: unknown): CodexShadowHomeError {
  return isCodexShadowHomeError(cause)
    ? cause
    : new CodexShadowHomeError({
        detail: "Failed to materialize Codex shadow home.",
        cause,
      });
}

function normalizeShadowHomeError<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, CodexShadowHomeError, R> {
  return effect.pipe(Effect.mapError(toShadowHomeError));
}

function isNotSymlinkError(error: PlatformError.PlatformError): boolean {
  const cause = error.reason.cause;
  return (
    error.reason._tag === "Unknown" &&
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "EINVAL"
  );
}

function stripWindowsExtendedPathPrefix(value: string): string {
  if (value.startsWith("\\\\?\\UNC\\")) {
    return `\\\\${value.slice("\\\\?\\UNC\\".length)}`;
  }
  if (value.startsWith("\\\\?\\")) {
    return value.slice("\\\\?\\".length);
  }
  return value;
}

function resolveLinkTarget(path: Path.Path, link: string, target: string): string {
  return stripWindowsExtendedPathPrefix(
    path.resolve(path.dirname(link), stripWindowsExtendedPathPrefix(target)),
  );
}

function areSameResolvedPath(path: Path.Path, left: string, right: string): boolean {
  const normalizedLeft = stripWindowsExtendedPathPrefix(path.resolve(left));
  const normalizedRight = stripWindowsExtendedPathPrefix(path.resolve(right));
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

const readLinkState = Effect.fn("CodexHomeLayout.readLinkState")(function* (
  fileSystem: FileSystem.FileSystem,
  linkPath: string,
): Effect.fn.Return<LinkState, CodexShadowHomeError> {
  return yield* fileSystem.readLink(linkPath).pipe(
    Effect.map((target): LinkState => ({ _tag: "Symlink", target })),
    Effect.catch((error) => {
      if (error.reason._tag === "NotFound") {
        return Effect.succeed<LinkState>({ _tag: "Missing" });
      }
      if (isNotSymlinkError(error)) {
        return Effect.succeed<LinkState>({ _tag: "NotSymlink" });
      }
      return Effect.fail(toShadowHomeError(error));
    }),
  );
});

const removePrivateSymlink = Effect.fn("CodexHomeLayout.removePrivateSymlink")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly shadowPath: string;
  readonly entryName: string;
}): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const privatePath = path.join(input.shadowPath, input.entryName);
  const state = yield* readLinkState(input.fileSystem, privatePath);
  if (state._tag === "Symlink") {
    yield* normalizeShadowHomeError(input.fileSystem.remove(privatePath));
  }
});

function runNodeFs<A>(operation: () => Promise<A>): Effect.Effect<A, CodexShadowHomeError> {
  return Effect.tryPromise({
    try: operation,
    catch: toShadowHomeError,
  });
}

function isSameFile(left: { dev: number; ino: number }, right: { dev: number; ino: number }) {
  return left.dev === right.dev && left.ino === right.ino && left.ino !== 0;
}

const ensureWindowsFileLink = Effect.fn("CodexHomeLayout.ensureWindowsFileLink")(function* (
  target: string,
  link: string,
) {
  const existing = yield* runNodeFs(() =>
    lstat(link).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    }),
  );

  if (existing) {
    if (existing.isDirectory() && !existing.isSymbolicLink()) {
      return yield* new CodexShadowHomeError({
        detail: `Cannot create Codex shadow home because '${link}' already exists and is not a file.`,
      });
    }

    const [targetStat, linkStat] = yield* runNodeFs(() =>
      Promise.all([statFile(target), statFile(link)]),
    );
    if (isSameFile(targetStat, linkStat)) {
      return;
    }

    yield* runNodeFs(() => rm(link, { force: true }));
  }

  yield* runNodeFs(async () => {
    try {
      await createHardLink(target, link);
    } catch {
      await copyFile(target, link);
    }
  });
});

const ensureWindowsDirectoryJunction = Effect.fn("CodexHomeLayout.ensureWindowsDirectoryJunction")(
  function* (input: {
    readonly path: Path.Path;
    readonly target: string;
    readonly link: string;
    readonly state: LinkState;
  }) {
    if (input.state._tag === "NotSymlink") {
      return yield* new CodexShadowHomeError({
        detail: `Cannot create Codex shadow home because '${input.link}' already exists and is not a Windows junction.`,
      });
    }

    if (input.state._tag === "Missing") {
      return yield* runNodeFs(() => createNodeSymlink(input.target, input.link, "junction"));
    }

    const resolvedExisting = resolveLinkTarget(input.path, input.link, input.state.target);
    if (!areSameResolvedPath(input.path, resolvedExisting, input.target)) {
      yield* runNodeFs(() => rm(input.link, { force: true }));
      yield* runNodeFs(() => createNodeSymlink(input.target, input.link, "junction"));
    }
  },
);

const ensureSymlink = Effect.fn("CodexHomeLayout.ensureSymlink")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly shadowPath: string;
  readonly sharedPath: string;
  readonly entryName: string;
  readonly entryType: "directory" | "file";
}): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const target = path.join(input.sharedPath, input.entryName);
  const link = path.join(input.shadowPath, input.entryName);
  const state = yield* readLinkState(input.fileSystem, link);

  if (process.platform === "win32") {
    if (input.entryType === "directory") {
      return yield* ensureWindowsDirectoryJunction({ path, target, link, state });
    }
    if (state._tag === "Symlink") {
      const resolvedExisting = resolveLinkTarget(path, link, state.target);
      if (areSameResolvedPath(path, resolvedExisting, target)) {
        return;
      }
      yield* runNodeFs(() => rm(link, { force: true }));
    }
    return yield* ensureWindowsFileLink(target, link);
  }

  if (state._tag === "NotSymlink") {
    return yield* new CodexShadowHomeError({
      detail: `Cannot create Codex shadow home because '${link}' already exists and is not a symlink.`,
    });
  }

  if (state._tag === "Missing") {
    return yield* normalizeShadowHomeError(input.fileSystem.symlink(target, link));
  }

  const resolvedExisting = path.resolve(path.dirname(link), state.target);
  if (!areSameResolvedPath(path, resolvedExisting, target)) {
    yield* normalizeShadowHomeError(input.fileSystem.remove(link));
    yield* normalizeShadowHomeError(input.fileSystem.symlink(target, link));
  }
});

/**
 * Atomically replace a private auth file: write an exclusive 0600 temp file in
 * the same directory, then rename it over the target so a reader never
 * observes a partially written token.
 */
const replacePrivateAuthFile = (path: Path.Path, targetPath: string, contents: string) => {
  const tempPath = path.join(
    path.dirname(targetPath),
    `.auth.json.${process.pid}.${randomUUID()}.tmp`,
  );
  return runNodeFs(async () => {
    try {
      await writeFile(tempPath, contents, { mode: 0o600, flag: "wx" });
      await chmodFile(tempPath, 0o600);
      await rename(tempPath, targetPath);
      await chmodFile(targetPath, 0o600);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  });
};

/**
 * Copy a renewed shadow login back to the shared auth file. The shared file is
 * re-read immediately before publication: if anything else (for example a
 * fresh `codex login` in a terminal) changed it after it was compared, the
 * write-back is abandoned and the next materialization re-evaluates. This
 * narrows, but cannot fully close, the window against a concurrent writer that
 * does not share a lock with Cafe; the same-subject/newer-renewal rule keeps
 * the worst case to replacing one renewal of a login with a newer one.
 */
const publishShadowRenewalToShared = Effect.fn("CodexHomeLayout.publishShadowRenewalToShared")(
  function* (
    path: Path.Path,
    sharedAuthPath: string,
    comparedSharedContents: string,
    renewedContents: string,
  ) {
    const unchanged = yield* runNodeFs(async () => {
      const current = await readFile(sharedAuthPath, "utf8");
      return current === comparedSharedContents;
    });
    if (!unchanged) return;
    yield* replacePrivateAuthFile(path, sharedAuthPath, renewedContents);
  },
);

const ensureShadowAuthIsPrivate = Effect.fn("CodexHomeLayout.ensureShadowAuthIsPrivate")(function* (
  fileSystem: FileSystem.FileSystem,
  authSourcePath: string,
  shadowPath: string,
): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const authPath = path.join(shadowPath, "auth.json");
  const state = yield* readLinkState(fileSystem, authPath);
  if (state._tag === "Symlink") {
    return yield* new CodexShadowHomeError({
      detail: `Codex shadow auth file '${authPath}' must be a real file, not a symlink.`,
    });
  }

  if (areSameResolvedPath(path, authSourcePath, shadowPath)) {
    if (state._tag === "NotSymlink") {
      yield* normalizeShadowHomeError(fileSystem.chmod(authPath, 0o600));
    }
    return;
  }

  const sharedAuthPath = path.join(authSourcePath, "auth.json");
  const sharedAuthState = yield* readLinkState(fileSystem, sharedAuthPath);
  if (sharedAuthState._tag === "Symlink") {
    return yield* new CodexShadowHomeError({
      detail: `Codex shared auth file '${sharedAuthPath}' must be a real file, not a symlink.`,
    });
  }

  if (sharedAuthState._tag === "Missing") {
    if (state._tag === "NotSymlink") {
      yield* runNodeFs(() => rm(authPath, { force: true }));
    }
    return;
  }

  const authContents = yield* normalizeShadowHomeError(fileSystem.readFileString(sharedAuthPath));
  if (state._tag === "NotSymlink") {
    const existingContents = yield* fileSystem
      .readFileString(authPath)
      .pipe(Effect.catch(() => Effect.sync((): string | undefined => undefined)));
    if (existingContents === authContents) {
      yield* normalizeShadowHomeError(fileSystem.chmod(authPath, 0o600));
      return;
    }
    // Codex persists a token renewal to its own CODEX_HOME, which is this
    // shadow. OpenAI refresh tokens are single-use, so overwriting a strictly
    // newer renewal of the same login with the shared copy would reinstate an
    // already-consumed refresh token and sign the account out on the next
    // renewal. Publish that renewal back to the shared source instead.
    if (
      existingContents !== undefined &&
      isNewerRenewalOfSameCodexLogin(existingContents, authContents)
    ) {
      yield* publishShadowRenewalToShared(path, sharedAuthPath, authContents, existingContents);
      yield* normalizeShadowHomeError(fileSystem.chmod(authPath, 0o600));
      return;
    }
  }

  yield* replacePrivateAuthFile(path, authPath, authContents);
});

export const materializeCodexShadowHome = Effect.fn("materializeCodexShadowHome")(function* (
  layout: CodexHomeLayout,
  options?: {
    readonly authSource?: CodexShadowHomeAuthSource;
  },
) {
  if (layout.mode !== "authOverlay") return;
  const effectiveHomePath = layout.effectiveHomePath;
  if (!effectiveHomePath) return;
  if (layout.sharedHomePath === effectiveHomePath) {
    return yield* new CodexShadowHomeError({
      detail: "Codex shadow home path must be different from the shared home path.",
    });
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* normalizeShadowHomeError(
    Effect.all(
      [
        fileSystem.makeDirectory(layout.sharedHomePath, { recursive: true }),
        fileSystem.makeDirectory(effectiveHomePath, { recursive: true }),
        ...KNOWN_SHARED_DIRECTORIES.map((directory) =>
          fileSystem.makeDirectory(path.join(layout.sharedHomePath, directory), {
            recursive: true,
          }),
        ),
      ],
      { concurrency: "unbounded" },
    ),
  );

  const sharedEntryNames = yield* normalizeShadowHomeError(
    fileSystem.readDirectory(layout.sharedHomePath),
  );
  const entries = new Set<string>(KNOWN_SHARED_DIRECTORIES);
  for (const entryName of sharedEntryNames) {
    if (shouldShareCodexShadowEntryName(entryName)) {
      entries.add(entryName);
    }
  }

  yield* Effect.forEach(
    sharedEntryNames,
    (entryName) =>
      entryName === "auth.json"
        ? Effect.void
        : shouldShareCodexShadowEntryName(entryName)
          ? Effect.void
          : removePrivateSymlink({
              fileSystem,
              shadowPath: effectiveHomePath,
              entryName,
            }),
    { discard: true },
  );

  yield* Effect.forEach(
    entries,
    (entryName) => {
      if (PRIVATE_ENTRY_NAMES.has(entryName)) {
        return Effect.void;
      }
      return ensureSymlink({
        fileSystem,
        shadowPath: effectiveHomePath,
        sharedPath: layout.sharedHomePath,
        entryName,
        entryType: KNOWN_SHARED_DIRECTORY_NAMES.has(entryName) ? "directory" : "file",
      });
    },
    { discard: true },
  );

  const authSourcePath =
    options?.authSource === "shadow" ? effectiveHomePath : layout.sharedHomePath;
  yield* ensureShadowAuthIsPrivate(fileSystem, authSourcePath, effectiveHomePath);
});

export function codexContinuationIdentity(layout: CodexHomeLayout) {
  return {
    driverKind: ProviderDriverKind.make("codex"),
    continuationKey: layout.continuationKey,
  };
}
