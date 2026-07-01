import type { DesktopReleaseUpdateState } from "@cafecode/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";

const RELEASE_UPDATE_STARTUP_DELAY = "12 seconds";
const RELEASE_UPDATE_POLL_INTERVAL = "6 hours";
const GITHUB_API_VERSION = "2022-11-28";
const REQUEST_TIMEOUT_MS = 15_000;

const { logInfo, logWarning } = DesktopObservability.makeComponentLogger("desktop-release-updates");

export interface DesktopReleaseUpdatesShape {
  readonly getState: Effect.Effect<DesktopReleaseUpdateState>;
  readonly configure: Effect.Effect<void, never, Scope.Scope>;
  readonly check: (reason: string) => Effect.Effect<DesktopReleaseUpdateState>;
}

export class DesktopReleaseUpdates extends Context.Service<
  DesktopReleaseUpdates,
  DesktopReleaseUpdatesShape
>()("cafecode/desktop/ReleaseUpdates") {}

const currentIsoTimestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));

class DesktopReleaseUpdateFetchError extends Data.TaggedError("DesktopReleaseUpdateFetchError")<{
  readonly cause: unknown;
}> {
  override get message() {
    return "Failed to query the latest GitHub release.";
  }
}

interface ParsedVersion {
  readonly release: ReadonlyArray<number>;
  readonly prerelease: string | null;
}

/**
 * Parse an `x.y.z[-prerelease][+build]` version (tolerating a leading `v`).
 * Returns null when the numeric core can't be understood so callers can refuse
 * to claim an update rather than guess.
 */
export function parseVersion(value: string): ParsedVersion | null {
  const trimmed = value.trim().replace(/^v/i, "");
  if (trimmed.length === 0) return null;
  const withoutBuild = trimmed.split("+")[0] ?? trimmed;
  const [core, ...preParts] = withoutBuild.split("-");
  if (!core) return null;
  const segments = core.split(".");
  const release: number[] = [];
  for (const segment of segments) {
    if (!/^\d+$/.test(segment)) return null;
    release.push(Number(segment));
  }
  if (release.length === 0) return null;
  return { release, prerelease: preParts.length > 0 ? preParts.join("-") : null };
}

/** Compare two versions: 1 if a > b, -1 if a < b, 0 if equal. Null if either is unparseable. */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  const length = Math.max(pa.release.length, pb.release.length);
  for (let index = 0; index < length; index += 1) {
    const left = pa.release[index] ?? 0;
    const right = pb.release[index] ?? 0;
    if (left !== right) return left > right ? 1 : -1;
  }
  // Equal numeric core: a release with no prerelease outranks one that has it.
  if (pa.prerelease === pb.prerelease) return 0;
  if (pa.prerelease === null) return 1;
  if (pb.prerelease === null) return -1;
  return pa.prerelease > pb.prerelease ? 1 : pa.prerelease < pb.prerelease ? -1 : 0;
}

/** Whether `latest` represents a newer version than `current`. */
export function isReleaseNewer(latest: string, current: string): boolean {
  const comparison = compareVersions(latest, current);
  return comparison !== null && comparison > 0;
}

interface ReleaseRepo {
  readonly owner: string;
  readonly repo: string;
}

/**
 * Extract `owner`/`repo` from a baked `app-update.yml` (electron-builder's
 * github publish provider). Its presence is also the signal that this build
 * should check GitHub for updates; distro/local builds omit it.
 */
function parseReleaseRepo(raw: string): ReleaseRepo | null {
  const entries: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^(\w+):\s*(.+)$/);
    if (match?.[1] && match[2]) {
      entries[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  if (entries.provider !== "github") return null;
  if (!entries.owner || !entries.repo) return null;
  return { owner: entries.owner, repo: entries.repo };
}

interface ReleaseCache {
  readonly etag: string | null;
  readonly latestVersion: string | null;
  readonly releaseUrl: string | null;
}

const EMPTY_CACHE: ReleaseCache = { etag: null, latestVersion: null, releaseUrl: null };

type ReleaseFetchResult =
  | { readonly kind: "not-modified" }
  | { readonly kind: "no-releases" }
  | { readonly kind: "error"; readonly status: number }
  | {
      readonly kind: "ok";
      readonly etag: string | null;
      readonly tagName: string | null;
      readonly htmlUrl: string | null;
    };

function fetchLatestRelease(
  repo: ReleaseRepo,
  etag: string | null,
): Effect.Effect<ReleaseFetchResult, DesktopReleaseUpdateFetchError> {
  return Effect.tryPromise({
    try: async (): Promise<ReleaseFetchResult> => {
      const response = await fetch(
        `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases/latest`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": GITHUB_API_VERSION,
            "User-Agent": "cafe-code-desktop",
            ...(etag ? { "If-None-Match": etag } : {}),
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
      if (response.status === 304) return { kind: "not-modified" };
      if (response.status === 404) return { kind: "no-releases" };
      if (!response.ok) return { kind: "error", status: response.status };
      const body = (await response.json()) as { tag_name?: unknown; html_url?: unknown };
      return {
        kind: "ok",
        etag: response.headers.get("etag"),
        tagName: typeof body.tag_name === "string" ? body.tag_name : null,
        htmlUrl: typeof body.html_url === "string" ? body.html_url : null,
      };
    },
    catch: (cause) => new DesktopReleaseUpdateFetchError({ cause }),
  });
}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const fileSystem = yield* FileSystem.FileSystem;

  const initialState: DesktopReleaseUpdateState = {
    status: "idle",
    currentVersion: environment.appVersion,
    latestVersion: null,
    releaseUrl: null,
    checkedAt: null,
    message: null,
  };

  const stateRef = yield* Ref.make<DesktopReleaseUpdateState>(initialState);
  const inFlightRef = yield* Ref.make(false);
  const cachePath = `${environment.stateDir}/release-update-cache.json`;

  const emitState = Ref.get(stateRef).pipe(
    Effect.flatMap((state) =>
      electronWindow.sendAll(IpcChannels.RELEASE_UPDATE_STATE_CHANNEL, state),
    ),
  );
  const setState = (state: DesktopReleaseUpdateState): Effect.Effect<void> =>
    Ref.set(stateRef, state).pipe(Effect.andThen(emitState));

  const readCache = fileSystem.readFileString(cachePath, "utf-8").pipe(
    Effect.map((raw) => JSON.parse(raw) as Partial<ReleaseCache>),
    Effect.map(
      (parsed): ReleaseCache => ({
        etag: typeof parsed.etag === "string" ? parsed.etag : null,
        latestVersion: typeof parsed.latestVersion === "string" ? parsed.latestVersion : null,
        releaseUrl: typeof parsed.releaseUrl === "string" ? parsed.releaseUrl : null,
      }),
    ),
    Effect.catch(() => Effect.succeed(EMPTY_CACHE)),
  );

  const writeCache = (cache: ReleaseCache): Effect.Effect<void> =>
    fileSystem
      .writeFileString(cachePath, JSON.stringify(cache))
      .pipe(Effect.catchCause(() => Effect.void));

  const readReleaseRepo = fileSystem.readFileString(environment.appUpdateYmlPath, "utf-8").pipe(
    Effect.map(parseReleaseRepo),
    Effect.catch(() => Effect.succeed(null)),
  );

  const resolveState = (
    repo: ReleaseRepo,
    cache: ReleaseCache,
    result: ReleaseFetchResult,
    checkedAt: string,
  ): { readonly state: DesktopReleaseUpdateState; readonly cache: ReleaseCache } => {
    const releasesPageUrl = `https://github.com/${repo.owner}/${repo.repo}/releases`;

    if (result.kind === "error") {
      return {
        cache,
        state: {
          status: "error",
          currentVersion: environment.appVersion,
          latestVersion: cache.latestVersion,
          releaseUrl: cache.releaseUrl,
          checkedAt,
          message: `GitHub returned status ${result.status} while checking for updates.`,
        },
      };
    }

    if (result.kind === "no-releases") {
      return {
        cache: EMPTY_CACHE,
        state: {
          status: "up-to-date",
          currentVersion: environment.appVersion,
          latestVersion: null,
          releaseUrl: null,
          checkedAt,
          message: "No published releases were found.",
        },
      };
    }

    // 304 Not Modified — reuse the cached latest version.
    const latestVersion = result.kind === "ok" ? result.tagName : cache.latestVersion;
    const nextCache: ReleaseCache =
      result.kind === "ok"
        ? {
            etag: result.etag ?? cache.etag,
            latestVersion: result.tagName,
            releaseUrl: result.htmlUrl ?? releasesPageUrl,
          }
        : cache;

    if (!latestVersion) {
      return {
        cache: nextCache,
        state: {
          status: "up-to-date",
          currentVersion: environment.appVersion,
          latestVersion: null,
          releaseUrl: null,
          checkedAt,
          message: "Could not determine the latest release version.",
        },
      };
    }

    const updateAvailable = isReleaseNewer(latestVersion, environment.appVersion);
    return {
      cache: nextCache,
      state: {
        status: updateAvailable ? "available" : "up-to-date",
        currentVersion: environment.appVersion,
        latestVersion,
        // Always point at the releases page so the pill can deep-link there.
        releaseUrl: nextCache.releaseUrl ?? releasesPageUrl,
        checkedAt,
        message: updateAvailable
          ? `${latestVersion} is available to download.`
          : "You are running the latest release.",
      },
    };
  };

  const check: DesktopReleaseUpdatesShape["check"] = (reason: string) =>
    Effect.gen(function* () {
      const inFlight = yield* Ref.get(inFlightRef);
      if (inFlight) return yield* Ref.get(stateRef);
      yield* Ref.set(inFlightRef, true);

      const previous = yield* Ref.get(stateRef);
      const repo = yield* readReleaseRepo;
      if (!repo) {
        const checkedAt = yield* currentIsoTimestamp;
        const next: DesktopReleaseUpdateState = {
          status: "unavailable",
          currentVersion: environment.appVersion,
          latestVersion: null,
          releaseUrl: null,
          checkedAt,
          message: "This build is not configured for GitHub release updates.",
        };
        yield* setState(next);
        return next;
      }

      yield* setState({ ...previous, status: "checking", message: "Checking for updates." });
      const cache = yield* readCache;

      const next = yield* fetchLatestRelease(repo, cache.etag).pipe(
        Effect.flatMap((result) =>
          currentIsoTimestamp.pipe(
            Effect.flatMap((checkedAt) => {
              const resolved = resolveState(repo, cache, result, checkedAt);
              return writeCache(resolved.cache).pipe(
                Effect.andThen(
                  logInfo("release update check completed", {
                    reason,
                    status: resolved.state.status,
                    latestVersion: resolved.state.latestVersion,
                    currentVersion: resolved.state.currentVersion,
                  }),
                ),
                Effect.as(resolved.state),
              );
            }),
          ),
        ),
        Effect.catchCause(
          Effect.fn("desktop.releaseUpdates.handleCheckFailure")(function* (cause) {
            const checkedAt = yield* currentIsoTimestamp;
            yield* logWarning("release update check failed", {
              reason,
              cause: Cause.pretty(cause),
            });
            return {
              status: "error" as const,
              currentVersion: environment.appVersion,
              latestVersion: cache.latestVersion,
              releaseUrl: cache.releaseUrl,
              checkedAt,
              message: "Could not reach GitHub to check for updates.",
            } satisfies DesktopReleaseUpdateState;
          }),
        ),
      );

      yield* setState(next);
      return next;
    }).pipe(Effect.ensuring(Ref.set(inFlightRef, false)));

  const configure: Effect.Effect<void, never, Scope.Scope> = Effect.gen(function* () {
    // Only packaged builds use the GitHub release check; source/dev checkouts
    // rely on DesktopSourceUpdates (git) instead.
    if (!environment.isPackaged) {
      return;
    }
    yield* Effect.sleep(RELEASE_UPDATE_STARTUP_DELAY).pipe(
      Effect.andThen(check("startup")),
      Effect.catchCause((cause) =>
        logWarning("startup release update check failed", { cause: Cause.pretty(cause) }),
      ),
      Effect.forkScoped,
    );
    yield* Effect.sleep(RELEASE_UPDATE_POLL_INTERVAL).pipe(
      Effect.andThen(check("poll")),
      Effect.forever,
      Effect.catchCause((cause) =>
        logWarning("release update poll failed", { cause: Cause.pretty(cause) }),
      ),
      Effect.forkScoped,
    );
  }).pipe(Effect.withSpan("desktop.releaseUpdates.configure"));

  return DesktopReleaseUpdates.of({
    getState: Ref.get(stateRef),
    configure,
    check,
  });
});

export const layer = Layer.effect(DesktopReleaseUpdates, make);
