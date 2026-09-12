// @effect-diagnostics nodeBuiltinImport:off
/**
 * WorkspaceObservatory live layer.
 *
 * Every request is anchored to a workspace root that the server resolves from
 * its own projection for the named `projectId`. Callers never supply a root, so
 * a compromised or buggy renderer cannot widen the observed surface.
 *
 * The layer performs only reads: `opendir`, `lstat`, `realpath`, and a single
 * bounded `read` on an `O_NOFOLLOW` descriptor. It never writes, never spawns a
 * process, and never opens a database.
 *
 * Residual limitation, deliberately not papered over: the portable
 * `lstat`/`realpath`/`open` sequence used here is *not* atomic. Node exposes no
 * portable directory-relative (`openat`-style) traversal, so between the moment
 * a path component is checked and the moment the final descriptor is opened, a
 * writer who already controls a parent directory inside the workspace can
 * replace a component with a link or with a different directory. The checks
 * below narrow that window and make the ordinary cases safe: `O_NOFOLLOW`
 * refuses a final symlink, the descriptor's own `fstat` is authoritative for the
 * object actually opened, and the device/inode comparison rejects a file that
 * was swapped. They do not close the window. The observatory is therefore a
 * read-only convenience view for whoever already owns the workspace, not a
 * sandbox boundary against a hostile co-writer of that workspace.
 *
 * @module WorkspaceObservatory
 */
import { constants } from "node:fs";
import { lstat, open, opendir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { WORKSPACE_OBSERVATORY_LIMITS } from "@cafecode/contracts";
import type {
  ProjectId,
  WorkspaceObservatoryFileResult,
  WorkspaceObservatoryTreeEntry,
  WorkspaceObservatoryTreeResult,
} from "@cafecode/contracts";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  WorkspaceObservatory,
  WorkspaceObservatoryDeniedError,
  type WorkspaceObservatoryDenialReason,
  type WorkspaceObservatoryShape,
} from "../Services/WorkspaceObservatory.ts";

/**
 * Directories that are never observable. They are large, generated, or hold
 * repository internals that can embed credentials and remote tokens.
 */
const DENIED_DIRECTORY_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".turbo",
  "build",
  "dist",
  "node_modules",
  "out",
  "target",
]);

/**
 * Best-effort sensitive-name detection. This reduces accidental exposure of
 * obvious credential files. It is not a secret-protection boundary.
 */
const SENSITIVE_PATH_NAME =
  /(?:^|[._-])(auth|credentials?|private|secrets?|sessions?|tokens?)(?:[._-]|$)|^(?:id_(?:rsa|dsa|ecdsa|ed25519)|\.env(?:\..*)?)$|\.(?:key|p12|pfx|pem)$/i;

const PRIVATE_KEY_BLOCK =
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g;

const TEXT_ASSIGNMENT =
  /^([ \t]*(?:(?:const|let|var)[ \t]+)?["']?([A-Za-z0-9_.-]+)["']?[ \t]*[:=][ \t]*)(.+)$/gim;
const SENSITIVE_ASSIGNMENT_KEY =
  /pass(?:word)?|secret|token|api.?key|credential|authori[sz]ation|cookie|session/i;

/** Win32 device names resolve to devices rather than to files on disk. */
const WINDOWS_RESERVED_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/**
 * Concurrent filesystem operations the observatory runs at once, across every
 * connected client of one server process.
 */
export const WORKSPACE_OBSERVATORY_MAX_CONCURRENT_OPERATIONS = 4;

/** Wall-clock deadline for one admitted observatory filesystem operation. */
export const WORKSPACE_OBSERVATORY_OPERATION_TIMEOUT_MS = 5_000;

/**
 * Per-listing budget for `lstat` fallbacks on directory entries whose kind the
 * directory read did not report. See `listDirectory`.
 */
export const WORKSPACE_OBSERVATORY_ENTRY_METADATA_BUDGET = 64;

function deny(reason: WorkspaceObservatoryDenialReason, detail: string): never {
  throw new WorkspaceObservatoryDeniedError({ reason, detail });
}

function toPosix(value: string): string {
  return value.replaceAll("\\", "/");
}

/** NUL, written without embedding a control character in this source file. */
const NUL_CHARACTER = String.fromCharCode(0);

/** The slice of the `node:path` API that containment needs. */
interface ContainmentPathApi {
  readonly relative: (from: string, to: string) => string;
  readonly isAbsolute: (value: string) => boolean;
  readonly sep: string;
}

const HOST_PATH: ContainmentPathApi = { relative, isAbsolute, sep };

/**
 * Containment test for two already-resolved absolute paths, evaluated under an
 * explicit path implementation.
 *
 * `relative` cannot express a relative step between two paths that share no
 * common prefix, and in that case it returns the *absolute* target instead of a
 * `..` walk. On Windows that happens for a different drive letter and also for a
 * UNC share, and the UNC result carries no drive-letter prefix at all, so a
 * drive-letter regexp misses it and an escaping target looks contained. Testing
 * `isAbsolute` on the *result* catches both shapes. The win32 interpretation is
 * consulted in addition to the supplied one, so a win32-shaped result is still
 * rejected when it is evaluated under POSIX rules.
 *
 * Taking the path implementation as a parameter is what lets the unit tests
 * assert real Windows semantics from any host instead of only from Windows.
 */
export function isContainedIn(pathApi: ContainmentPathApi, root: string, target: string): boolean {
  const fromRoot = pathApi.relative(root, target);
  if (fromRoot === "") return true;
  if (pathApi.isAbsolute(fromRoot) || win32.isAbsolute(fromRoot)) return false;
  return (
    fromRoot !== ".." && !fromRoot.startsWith(".." + pathApi.sep) && !fromRoot.startsWith("../")
  );
}

/** Containment under the host platform's own path rules. */
export function isContained(root: string, target: string): boolean {
  return isContainedIn(HOST_PATH, root, target);
}

/**
 * Path segments whose meaning is ambiguous on Windows. They are refused on
 * every platform so the observatory behaves identically everywhere:
 *
 * - `:` selects an NTFS alternate data stream (`notes.txt:hidden`), which a
 *   directory listing never shows, and also reintroduces a drive-relative path
 *   (`C:file`).
 * - Trailing dots and spaces are stripped by Win32 before the filesystem sees
 *   the name, so `secret.pem.` and `secret.pem` are two spellings of one file
 *   and a name-based denial could be bypassed through the unused spelling.
 * - Reserved device names open devices instead of files.
 * - Wildcards, redirection characters, and control characters are not valid in
 *   a Windows file name and have no place in an observable path.
 */
export function isAmbiguousSegment(segment: string): boolean {
  if (segment.includes(":")) return true;
  if (/[*?"<>|]/.test(segment)) return true;
  if (/[. ]$/.test(segment)) return true;
  if (WINDOWS_RESERVED_DEVICE_NAME.test(segment)) return true;
  // Checked by code point rather than a control-character regexp, which the
  // linter rightly flags as easy to misread.
  for (const character of segment) {
    if (character.codePointAt(0)! < 0x20) return true;
  }
  return false;
}

function pathSegments(value: string): readonly string[] {
  return toPosix(value).split("/").filter(Boolean);
}

/** Hidden entries, denied generated directories, and obvious credential names. */
function isDeniedSegment(segment: string): boolean {
  return (
    segment.startsWith(".") ||
    DENIED_DIRECTORY_NAMES.has(segment.toLowerCase()) ||
    SENSITIVE_PATH_NAME.test(segment)
  );
}

/**
 * Bounded admission for filesystem work that cannot be cancelled.
 *
 * Node's promise filesystem API runs on libuv's worker pool and offers no
 * cancellation, so one operation that blocks -- a named pipe, a dead network
 * mount -- occupies a worker until the operating system releases it. Two
 * properties follow from that and both are load-bearing:
 *
 * 1. Admission is a hard ceiling with *no* queue. A request that arrives while
 *    the pool is full is refused immediately with `busy`. There is no waiting
 *    list that can grow without bound and no backlog to drain later.
 * 2. The deadline frees the *caller*, never the slot. When an operation exceeds
 *    its deadline the request fails with `timed-out`, but the slot stays held
 *    until the underlying promise actually settles. That is what stops a stuck
 *    path from being retried into an ever-growing pile of blocked workers: once
 *    enough operations are wedged, the observatory refuses further work cheaply
 *    instead of spawning more stuck I/O.
 */
export interface WorkspaceObservatoryAdmission {
  /** Slots currently held, including slots held by timed-out operations. */
  readonly active: () => number;
  readonly run: <A>(operation: () => Promise<A>) => Promise<A>;
}

export function makeObservatoryAdmission(options?: {
  readonly maxConcurrent?: number;
  readonly timeoutMs?: number;
}): WorkspaceObservatoryAdmission {
  const maxConcurrent = options?.maxConcurrent ?? WORKSPACE_OBSERVATORY_MAX_CONCURRENT_OPERATIONS;
  const timeoutMs = options?.timeoutMs ?? WORKSPACE_OBSERVATORY_OPERATION_TIMEOUT_MS;
  let active = 0;

  return {
    active: () => active,
    run: <A>(operation: () => Promise<A>): Promise<A> => {
      if (active >= maxConcurrent) {
        return Promise.reject(
          new WorkspaceObservatoryDeniedError({
            reason: "busy",
            detail: "The workspace observatory is busy. Try again in a moment.",
          }),
        );
      }
      active += 1;
      let work: Promise<A>;
      try {
        work = operation();
      } catch (cause) {
        active -= 1;
        return Promise.reject(cause);
      }
      // The slot is released when the real operation settles, never when the
      // deadline fires. Observing the rejection here also keeps a late failure
      // from surfacing as an unhandled rejection after the caller gave up.
      void work
        .then(
          () => undefined,
          () => undefined,
        )
        .finally(() => {
          active -= 1;
        });

      return new Promise<A>((settleWith, failWith) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          failWith(
            new WorkspaceObservatoryDeniedError({
              reason: "timed-out",
              detail: "The workspace observatory request took too long.",
            }),
          );
        }, timeoutMs);
        timer.unref?.();
        work.then(
          (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            settleWith(value);
          },
          (cause: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            failWith(cause);
          },
        );
      });
    },
  };
}

/** Walk every segment below the root and refuse any link or reparse point. */
async function assertNoLinkOnPath(root: string, target: string): Promise<void> {
  const fromRoot = relative(root, target);
  if (fromRoot === "") return;
  let cursor = root;
  for (const segment of fromRoot.split(sep)) {
    cursor = resolve(cursor, segment);
    const metadata = await lstat(cursor).catch(() =>
      deny("unreadable", "Workspace item is unavailable."),
    );
    if (metadata.isSymbolicLink()) {
      deny("link", "Workspace links and reparse-point aliases are not displayed.");
    }
  }
}

/**
 * Resolve one workspace-relative request path against an already-real root.
 * Rejects absolute paths, NUL bytes, traversal, denied directories, links,
 * Windows-ambiguous spellings, and anything whose real location escapes the
 * root.
 */
async function resolveObservedTarget(root: string, relativePath: string): Promise<string> {
  if (relativePath.includes(NUL_CHARACTER)) deny("outside-root", "Invalid workspace path.");
  if (/^(?:[A-Za-z]:)?[/\\]/.test(relativePath)) {
    deny("outside-root", "Workspace path must stay within the project root.");
  }
  const segments = pathSegments(relativePath);
  if (segments.length === 0 || segments.includes("..")) {
    deny("outside-root", "Workspace path must stay within the project root.");
  }
  if (segments.some(isAmbiguousSegment)) {
    deny("outside-root", "Workspace path must stay within the project root.");
  }
  if (segments.some(isDeniedSegment)) {
    deny("sensitive-path", "Hidden, generated, or sensitive workspace items are not displayed.");
  }
  const candidate = resolve(root, segments.join(sep));
  if (!isContained(root, candidate) || relative(root, candidate) === "") {
    deny("outside-root", "Workspace path must stay within the project root.");
  }
  await assertNoLinkOnPath(root, candidate);
  const target = await realpath(candidate).catch(() =>
    deny("unreadable", "Workspace item is unavailable."),
  );
  if (!isContained(root, target)) {
    deny("outside-root", "Workspace path must stay within the project root.");
  }
  return target;
}

/** Trim a trailing partial UTF-8 sequence so a bounded read still decodes. */
function decodeBoundedUtf8(bytes: Buffer, complete: boolean): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: !complete });
  } catch {
    return deny("binary", "File is not valid UTF-8 text.");
  }
}

function truncateUtf8(value: string, maximumBytes: number): { value: string; truncated: boolean } {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= maximumBytes) return { value, truncated: false };
  let end = maximumBytes;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  return { value: encoded.subarray(0, end).toString("utf8"), truncated: true };
}

/** Best-effort masking of obvious credential shapes in returned text. */
export function redactObservedText(value: string): { value: string; redacted: boolean } {
  let redacted = false;
  const withoutPrivateKeys = value.replace(PRIVATE_KEY_BLOCK, () => {
    redacted = true;
    return "[redacted private key]";
  });
  const output = withoutPrivateKeys.replace(
    TEXT_ASSIGNMENT,
    (match, prefix: string, key: string) => {
      if (!SENSITIVE_ASSIGNMENT_KEY.test(key)) return match;
      redacted = true;
      return `${prefix}[redacted]`;
    },
  );
  return { value: output, redacted };
}

/** Entry kinds a directory read can report without a follow-up syscall. */
type ScannedKind = "file" | "directory" | "link" | "other" | "unknown";

function scannedKindOf(entry: {
  isSymbolicLink: () => boolean;
  isDirectory: () => boolean;
  isFile: () => boolean;
}): ScannedKind {
  if (entry.isSymbolicLink()) return "link";
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  return "unknown";
}

/**
 * List one directory with a bounded number of filesystem operations.
 *
 * The directory read already reports a kind for each entry, so the ordinary
 * path costs one `opendir` walk and no per-entry syscalls at all. Only entries
 * whose kind the platform left unknown fall back to `lstat`, and that fallback
 * is capped by `WORKSPACE_OBSERVATORY_ENTRY_METADATA_BUDGET`; beyond the cap the
 * remaining unknown entries are reported as truncated instead of probed. This
 * replaces three sequential metadata calls per name, which let a single
 * 500-entry listing issue up to 1500 sequential filesystem operations while
 * holding one admission slot for the whole series.
 *
 * Dropping the per-entry `realpath` does not weaken containment: the parent was
 * already proven link-free and real, each entry name is a single segment that is
 * neither `.` nor `..`, and any entry that is itself a link is discarded. The
 * string containment check is kept as a cheap backstop.
 */
async function listDirectory(
  root: string,
  target: string,
): Promise<{ entries: WorkspaceObservatoryTreeEntry[]; truncated: boolean; redacted: boolean }> {
  const targetStat = await stat(target).catch(() =>
    deny("unreadable", "Workspace item is unavailable."),
  );
  if (!targetStat.isDirectory()) deny("not-a-directory", "Workspace item is not a directory.");

  const handle = await opendir(target).catch(() =>
    deny("unreadable", "Workspace directory cannot be read."),
  );
  const scanned: { name: string; kind: ScannedKind }[] = [];
  let truncated = false;
  try {
    for await (const entry of handle) {
      if (scanned.length >= WORKSPACE_OBSERVATORY_LIMITS.treeEntries) {
        truncated = true;
        break;
      }
      scanned.push({ name: entry.name, kind: scannedKindOf(entry) });
    }
  } finally {
    await handle.close().catch(() => undefined);
  }

  const entries: WorkspaceObservatoryTreeEntry[] = [];
  let redacted = false;
  let metadataBudget = WORKSPACE_OBSERVATORY_ENTRY_METADATA_BUDGET;
  for (const scan of scanned.toSorted((left, right) => left.name.localeCompare(right.name))) {
    const { name } = scan;
    if (isDeniedSegment(name) || isAmbiguousSegment(name)) {
      redacted = true;
      continue;
    }
    let kind: ScannedKind = scan.kind;
    if (kind === "unknown") {
      if (metadataBudget <= 0) {
        truncated = true;
        continue;
      }
      metadataBudget -= 1;
      const link = await lstat(resolve(target, name)).catch(() => null);
      if (!link) continue;
      kind = scannedKindOf(link) === "unknown" ? "other" : scannedKindOf(link);
    }
    if (kind !== "file" && kind !== "directory") continue;
    const resolved = resolve(target, name);
    if (!isContained(root, resolved)) continue;
    const entryRelativePath = toPosix(relative(root, resolved));
    if (
      entryRelativePath.length === 0 ||
      entryRelativePath.length > WORKSPACE_OBSERVATORY_LIMITS.relativePathLength
    ) {
      truncated = true;
      continue;
    }
    entries.push({ name, relativePath: entryRelativePath, kind });
  }
  return { entries, truncated, redacted };
}

async function readBoundedFile(
  root: string,
  target: string,
): Promise<WorkspaceObservatoryFileResult> {
  // Establish that this is a regular file *before* opening it. `open` on a
  // named pipe with no writer blocks until a writer appears, and that block
  // happens on a libuv worker thread that cannot be cancelled or interrupted,
  // so without this check one FIFO inside the workspace could occupy a worker
  // for the lifetime of the process. The check does not replace the descriptor
  // check below -- the entry can still change in between -- it is what keeps the
  // blocking case from being reachable in the first place.
  const precheck = await lstat(target).catch(() =>
    deny("unreadable", "Workspace item is unavailable."),
  );
  if (precheck.isSymbolicLink()) {
    deny("link", "Workspace links and reparse-point aliases are not displayed.");
  }
  if (!precheck.isFile()) deny("not-a-file", "Workspace item is not a regular file.");

  // `O_NONBLOCK` narrows the remaining race: if the entry is swapped for a FIFO
  // between the check above and this open, the open fails or returns
  // immediately instead of waiting for a writer. POSIX specifies no effect for
  // regular files, and the flag is absent on Windows, where `?? 0` leaves the
  // flags unchanged.
  const openFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const handle = await open(target, openFlags).catch(() =>
    deny("unreadable", "Workspace item cannot be opened safely."),
  );
  try {
    // Descriptor-level type check. This one is authoritative: it describes the
    // object actually opened rather than the name that was looked up.
    const opened = await handle.stat();
    if (!opened.isFile()) deny("not-a-file", "Workspace item is not a regular file.");
    const revalidated = await realpath(target).catch(() =>
      deny("unreadable", "Workspace item is unavailable."),
    );
    if (!isContained(root, revalidated)) {
      deny("outside-root", "Workspace item moved outside the project root.");
    }
    const current = await stat(revalidated).catch(() =>
      deny("unreadable", "Workspace item is unavailable."),
    );
    if (opened.dev !== current.dev || opened.ino !== current.ino) {
      deny("changed-while-reading", "Workspace item changed while it was being opened.");
    }
    // One extra byte only tells us whether more content exists past the limit.
    const maximumReadBytes = WORKSPACE_OBSERVATORY_LIMITS.textBytes + 1;
    const buffer = Buffer.alloc(Math.min(opened.size, maximumReadBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) deny("binary", "Binary files cannot be displayed.");
    const complete = bytesRead >= opened.size;
    const content = decodeBoundedUtf8(bytes, complete);
    const redaction = redactObservedText(content);
    const bounded = truncateUtf8(redaction.value, WORKSPACE_OBSERVATORY_LIMITS.textBytes);
    return {
      relativePath: toPosix(relative(root, target)),
      content: bounded.value,
      truncated: !complete || bounded.truncated,
      redacted: redaction.redacted,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Resolves the authoritative workspace root for a project id. */
export type WorkspaceObservatoryRootResolver = (
  projectId: ProjectId,
) => Effect.Effect<string | null>;

const denied = (cause: unknown): WorkspaceObservatoryDeniedError =>
  cause instanceof WorkspaceObservatoryDeniedError
    ? cause
    : new WorkspaceObservatoryDeniedError({
        reason: "unreadable",
        detail: "Workspace item is unavailable.",
      });

/**
 * Build the observatory over an injected root resolver. Tests supply a
 * synthetic resolver so no real project registry is ever consulted.
 *
 * The admission controller is created here, so one observatory instance -- and
 * therefore one server process -- has a single bounded filesystem budget shared
 * by every connected client.
 */
export function makeWorkspaceObservatory(
  resolveWorkspaceRoot: WorkspaceObservatoryRootResolver,
  admission: WorkspaceObservatoryAdmission = makeObservatoryAdmission(),
): WorkspaceObservatoryShape {
  const realRootFor = Effect.fn("WorkspaceObservatory.realRootFor")(function* (
    projectId: ProjectId,
  ) {
    const workspaceRoot = yield* resolveWorkspaceRoot(projectId);
    if (!workspaceRoot) {
      return yield* new WorkspaceObservatoryDeniedError({
        reason: "unknown-project",
        detail: "Project is not part of this connected environment.",
      });
    }
    return yield* Effect.tryPromise({
      try: () => admission.run(() => realpath(workspaceRoot)),
      catch: (cause) =>
        // An admission refusal is already a denial and keeps its own reason; any
        // other failure is reported as an unavailable root.
        cause instanceof WorkspaceObservatoryDeniedError
          ? cause
          : new WorkspaceObservatoryDeniedError({
              reason: "root-unavailable",
              detail: "Workspace root is unavailable.",
            }),
    });
  });

  const tree: WorkspaceObservatoryShape["tree"] = Effect.fn("WorkspaceObservatory.tree")(
    function* (input) {
      const root = yield* realRootFor(input.projectId);
      const requested = input.relativePath ?? "";
      const listing: WorkspaceObservatoryTreeResult = yield* Effect.tryPromise({
        try: () =>
          admission.run(async () => {
            const target =
              requested === "" || requested === "."
                ? root
                : await resolveObservedTarget(root, requested);
            const result = await listDirectory(root, target);
            return {
              relativePath: toPosix(relative(root, target)),
              entries: result.entries,
              truncated: result.truncated,
              redacted: result.redacted,
            };
          }),
        catch: denied,
      });
      return listing;
    },
  );

  const readFile: WorkspaceObservatoryShape["readFile"] = Effect.fn(
    "WorkspaceObservatory.readFile",
  )(function* (input) {
    const root = yield* realRootFor(input.projectId);
    return yield* Effect.tryPromise({
      try: () =>
        admission.run(async () => {
          const target = await resolveObservedTarget(root, input.relativePath);
          return await readBoundedFile(root, target);
        }),
      catch: denied,
    });
  });

  return { tree, readFile } satisfies WorkspaceObservatoryShape;
}

/**
 * Live layer. The workspace root comes from the orchestration projection for
 * the selected project, which is the server's own record of what the user
 * registered.
 */
export const WorkspaceObservatoryLive = Layer.effect(
  WorkspaceObservatory,
  Effect.gen(function* () {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    return makeWorkspaceObservatory((projectId) =>
      projectionSnapshotQuery.getProjectShellById(projectId).pipe(
        Effect.map(
          Option.match({ onNone: () => null, onSome: (project) => project.workspaceRoot }),
        ),
        Effect.catch(() => Effect.succeed(null)),
      ),
    );
  }),
);
