import type {
  DesktopSourceUpdateState,
  DesktopSourceUpdateTrackedBranch,
} from "@cafecode/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";

const SOURCE_UPDATE_STARTUP_DELAY = "5 seconds";
const SOURCE_UPDATE_POLL_INTERVAL = "30 minutes";
const GIT_COMMAND_TIMEOUT_MS = 20_000;
const TRACKED_BRANCHES = new Set<string>(["main", "dev"]);

const { logInfo, logWarning } = DesktopObservability.makeComponentLogger("desktop-source-updates");

export interface DesktopSourceUpdatesShape {
  readonly getState: Effect.Effect<DesktopSourceUpdateState>;
  readonly configure: Effect.Effect<void, never, Scope.Scope>;
  readonly check: (reason: string) => Effect.Effect<DesktopSourceUpdateState>;
}

export class DesktopSourceUpdates extends Context.Service<
  DesktopSourceUpdates,
  DesktopSourceUpdatesShape
>()("cafecode/desktop/SourceUpdates") {}

const INITIAL_SOURCE_UPDATE_STATE: DesktopSourceUpdateState = {
  status: "idle",
  branch: null,
  trackedBranch: null,
  localHash: null,
  remoteHash: null,
  mergeBaseHash: null,
  dirty: null,
  checkedAt: null,
  message: null,
};

const currentIsoTimestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));

class DesktopSourceUpdateGitError extends Data.TaggedError("DesktopSourceUpdateGitError")<{
  readonly cwd: string;
  readonly args: readonly string[];
  readonly cause: unknown;
}> {
  override get message() {
    return `Git source update command failed: git ${this.args.join(" ")}`;
  }
}

interface GitCommandOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: ChildProcessSpawner.ExitCode | null;
}

const collectStreamText = Effect.fn("desktop.sourceUpdates.collectStreamText")(function* (
  stream: Stream.Stream<Uint8Array, unknown>,
) {
  const result = yield* stream.pipe(
    Stream.runFold(
      () => ({ chunks: [] as Uint8Array[], bytes: 0, truncated: false }),
      (state, chunk) => {
        if (state.truncated) {
          return state;
        }
        const nextBytes = state.bytes + chunk.byteLength;
        if (nextBytes > 256 * 1024) {
          return { ...state, truncated: true };
        }
        state.chunks.push(chunk);
        return { chunks: state.chunks, bytes: nextBytes, truncated: false };
      },
    ),
    Effect.mapError(
      (cause) => new DesktopSourceUpdateGitError({ cwd: "<stream>", args: [], cause }),
    ),
  );
  return Buffer.concat(result.chunks, result.bytes).toString("utf8");
});

function runGitCore(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  cwd: string,
  args: readonly string[],
): Effect.Effect<GitCommandOutput, DesktopSourceUpdateGitError, Scope.Scope> {
  return Effect.gen(function* () {
    const child = yield* spawner
      .spawn(ChildProcess.make("git", [...args], { cwd }))
      .pipe(Effect.mapError((cause) => new DesktopSourceUpdateGitError({ cwd, args, cause })));

    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamText(child.stdout).pipe(
          Effect.mapError((cause) => new DesktopSourceUpdateGitError({ cwd, args, cause })),
        ),
        collectStreamText(child.stderr).pipe(
          Effect.mapError((cause) => new DesktopSourceUpdateGitError({ cwd, args, cause })),
        ),
        child.exitCode.pipe(
          Effect.mapError((cause) => new DesktopSourceUpdateGitError({ cwd, args, cause })),
        ),
      ],
      { concurrency: "unbounded" },
    );

    return { stdout, stderr, exitCode };
  });
}

function runGit(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  cwd: string,
  args: readonly string[],
): Effect.Effect<GitCommandOutput, DesktopSourceUpdateGitError> {
  return runGitCore(spawner, cwd, args).pipe(
    Effect.scoped,
    Effect.timeoutOption(Duration.millis(GIT_COMMAND_TIMEOUT_MS)),
    Effect.flatMap((result) => {
      if (Option.isSome(result)) {
        return Effect.succeed(result.value);
      }
      return Effect.fail(new DesktopSourceUpdateGitError({ cwd, args, cause: "timeout" }));
    }),
  );
}

const runGitText = Effect.fn("desktop.sourceUpdates.runGitText")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  cwd: string,
  args: readonly string[],
) {
  const result = yield* runGit(spawner, cwd, args);
  if (result.exitCode !== 0) {
    return null;
  }
  const trimmed = result.stdout.trim();
  return trimmed.length > 0 ? trimmed : null;
});

const isGitSuccess = Effect.fn("desktop.sourceUpdates.isGitSuccess")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  cwd: string,
  args: readonly string[],
) {
  const result = yield* runGit(spawner, cwd, args);
  return result.exitCode === 0;
});

function shortHash(hash: string | null) {
  return hash ? hash.slice(0, 12) : null;
}

function normalizeTrackedBranch(branch: string | null): DesktopSourceUpdateTrackedBranch | null {
  if (branch === "main" || branch === "dev") return branch;
  return null;
}

export const checkSourceUpdateForTests = Effect.fn("desktop.sourceUpdates.check")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  cwd: string,
) {
  const checkedAt = yield* currentIsoTimestamp;
  const repoRoot = yield* runGitText(spawner, cwd, ["rev-parse", "--show-toplevel"]).pipe(
    Effect.catch(() => Effect.succeed(null)),
  );

  if (!repoRoot) {
    return {
      ...INITIAL_SOURCE_UPDATE_STATE,
      status: "unavailable",
      checkedAt,
      message: "No git checkout was found for this Cafe Code install.",
    };
  }

  const [branch, localHash, dirtyOutput] = yield* Effect.all([
    runGitText(spawner, repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
    runGitText(spawner, repoRoot, ["rev-parse", "HEAD"]),
    runGitText(spawner, repoRoot, ["status", "--porcelain=v1"]),
  ]).pipe(
    Effect.catch((error) =>
      Effect.succeed<[string | null, string | null, string | null]>([null, null, error.message]),
    ),
  );
  const trackedBranch = normalizeTrackedBranch(branch);
  const dirty = dirtyOutput !== null;

  if (!branch || !localHash) {
    return {
      ...INITIAL_SOURCE_UPDATE_STATE,
      status: "unavailable",
      branch,
      localHash,
      dirty,
      checkedAt,
      message: "Could not read local git branch or commit.",
    };
  }

  if (!trackedBranch || !TRACKED_BRANCHES.has(trackedBranch)) {
    return {
      ...INITIAL_SOURCE_UPDATE_STATE,
      status: "ignored",
      branch,
      localHash,
      dirty,
      checkedAt,
      message: "Only branches main and dev are tracked.",
    };
  }

  // The branch is whitelisted above before it is passed into refspec argv.
  // Local dirty files are intentionally ignored for update detection; they are
  // reported separately through `dirty` while commit comparison uses HEAD and
  // the fetched remote ref.
  const fetchResult = yield* runGit(spawner, repoRoot, [
    "fetch",
    "--quiet",
    "--no-tags",
    "origin",
    `refs/heads/${trackedBranch}:refs/remotes/origin/${trackedBranch}`,
  ]).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        stdout: "",
        stderr: error.message,
        exitCode: ChildProcessSpawner.ExitCode(1),
      }),
    ),
  );
  if (fetchResult.exitCode !== 0) {
    return {
      ...INITIAL_SOURCE_UPDATE_STATE,
      status: "error",
      branch,
      trackedBranch,
      localHash,
      dirty,
      checkedAt,
      message: "Could not fetch the latest branch hash from origin.",
    };
  }

  const remoteRef = `origin/${trackedBranch}`;
  const remoteHash = yield* runGitText(spawner, repoRoot, ["rev-parse", remoteRef]).pipe(
    Effect.catch(() => Effect.succeed(null)),
  );
  const mergeBaseHash = yield* runGitText(spawner, repoRoot, [
    "merge-base",
    "HEAD",
    remoteRef,
  ]).pipe(Effect.catch(() => Effect.succeed(null)));

  if (!remoteHash) {
    return {
      ...INITIAL_SOURCE_UPDATE_STATE,
      status: "error",
      branch,
      trackedBranch,
      localHash,
      dirty,
      checkedAt,
      message: `Could not resolve ${remoteRef}.`,
    };
  }

  if (localHash === remoteHash) {
    return {
      ...INITIAL_SOURCE_UPDATE_STATE,
      status: "current",
      branch,
      trackedBranch,
      localHash,
      remoteHash,
      mergeBaseHash,
      dirty,
      checkedAt,
      message: "This checkout is current with origin.",
    };
  }

  const localIsAncestor = yield* isGitSuccess(spawner, repoRoot, [
    "merge-base",
    "--is-ancestor",
    "HEAD",
    remoteRef,
  ]).pipe(Effect.catch(() => Effect.succeed(false)));
  if (localIsAncestor) {
    return {
      ...INITIAL_SOURCE_UPDATE_STATE,
      status: "behind",
      branch,
      trackedBranch,
      localHash,
      remoteHash,
      mergeBaseHash,
      dirty,
      checkedAt,
      message: `A newer ${trackedBranch} commit is available at ${shortHash(remoteHash)}.`,
    };
  }

  const remoteIsAncestor = yield* isGitSuccess(spawner, repoRoot, [
    "merge-base",
    "--is-ancestor",
    remoteRef,
    "HEAD",
  ]).pipe(Effect.catch(() => Effect.succeed(false)));

  return {
    ...INITIAL_SOURCE_UPDATE_STATE,
    status: remoteIsAncestor ? "ahead" : "diverged",
    branch,
    trackedBranch,
    localHash,
    remoteHash,
    mergeBaseHash,
    dirty,
    checkedAt,
    message: remoteIsAncestor
      ? `This checkout is ahead of origin/${trackedBranch}.`
      : `This checkout has diverged from origin/${trackedBranch}.`,
  };
});

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const stateRef = yield* Ref.make<DesktopSourceUpdateState>(INITIAL_SOURCE_UPDATE_STATE);
  const inFlightRef = yield* Ref.make(false);

  const emitState = Ref.get(stateRef).pipe(
    Effect.flatMap((state) =>
      electronWindow.sendAll(IpcChannels.SOURCE_UPDATE_STATE_CHANNEL, state),
    ),
  );
  const setState = (state: DesktopSourceUpdateState): Effect.Effect<void> =>
    Ref.set(stateRef, state).pipe(Effect.andThen(emitState));

  const check: DesktopSourceUpdatesShape["check"] = (reason: string) =>
    Effect.gen(function* () {
      const inFlight = yield* Ref.get(inFlightRef);
      if (inFlight) {
        return yield* Ref.get(stateRef);
      }

      yield* Ref.set(inFlightRef, true);
      const previous = yield* Ref.get(stateRef);
      yield* setState({ ...previous, status: "checking", message: "Checking branch hash." });

      const next: DesktopSourceUpdateState = yield* checkSourceUpdateForTests(
        spawner,
        environment.appRoot,
      ).pipe(
        Effect.map((state): DesktopSourceUpdateState => state as DesktopSourceUpdateState),
        Effect.tap((state) =>
          logInfo("source update check completed", {
            reason,
            status: state.status,
            branch: state.branch,
            trackedBranch: state.trackedBranch,
            localHash: shortHash(state.localHash),
            remoteHash: shortHash(state.remoteHash),
            dirty: state.dirty,
          }),
        ),
        Effect.catchCause(
          Effect.fn("desktop.sourceUpdates.handleCheckFailure")(function* (cause) {
            const checkedAt = yield* currentIsoTimestamp;
            yield* logWarning("source update check failed", { reason, cause: Cause.pretty(cause) });
            return {
              ...previous,
              status: "error" as const,
              checkedAt,
              message: "Could not check the source branch hash.",
            } satisfies DesktopSourceUpdateState;
          }),
        ),
      );

      yield* setState(next);
      yield* Ref.set(inFlightRef, false);
      return next;
    }).pipe(Effect.ensuring(Ref.set(inFlightRef, false)));

  const configure: Effect.Effect<void, never, Scope.Scope> = Effect.gen(function* () {
    yield* Effect.sleep(SOURCE_UPDATE_STARTUP_DELAY).pipe(
      Effect.andThen(check("startup")),
      Effect.catchCause((cause) =>
        logWarning("startup source update check failed", { cause: Cause.pretty(cause) }),
      ),
      Effect.forkScoped,
    );
    yield* Effect.sleep(SOURCE_UPDATE_POLL_INTERVAL).pipe(
      Effect.andThen(check("poll")),
      Effect.forever,
      Effect.catchCause((cause) =>
        logWarning("source update poll failed", { cause: Cause.pretty(cause) }),
      ),
      Effect.forkScoped,
    );
  }).pipe(Effect.withSpan("desktop.sourceUpdates.configure"));

  return DesktopSourceUpdates.of({
    getState: Ref.get(stateRef),
    configure,
    check,
  });
});

export const layer = Layer.effect(DesktopSourceUpdates, make);
