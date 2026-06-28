import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { createHash } from "node:crypto";
import { homedir } from "node:os";

import * as Electron from "electron";
import { isCommandAvailable } from "@cafecode/shared/shell";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as DesktopObservability from "../app/DesktopObservability.ts";

const SAFE_EXTERNAL_PROTOCOLS = new Set(["http:", "https:"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);
const DESKTOP_ENTRY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*\.desktop$/u;
const EXTERNAL_LAUNCH_TIMEOUT_MS = 2_000;
const EXTERNAL_LAUNCH_TIMEOUT = Duration.millis(EXTERNAL_LAUNCH_TIMEOUT_MS);
const EXTERNAL_LAUNCH_KILL_GRACE = Duration.millis(250);

const { logInfo, logWarning } = DesktopObservability.makeComponentLogger("desktop-shell");

export function parseSafeExternalUrl(rawUrl: unknown): Option.Option<string> {
  if (typeof rawUrl !== "string") {
    return Option.none();
  }

  try {
    const url = new URL(rawUrl);
    return SAFE_EXTERNAL_PROTOCOLS.has(url.protocol) ? Option.some(url.href) : Option.none();
  } catch {
    return Option.none();
  }
}

export function isLoopbackHttpUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return SAFE_EXTERNAL_PROTOCOLS.has(url.protocol) && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function hashLogValue(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function externalUrlLogMetadata(rawUrl: unknown): Record<string, unknown> {
  if (typeof rawUrl !== "string") {
    return { targetType: typeof rawUrl };
  }

  try {
    const url = new URL(rawUrl);
    return {
      targetType: "url",
      protocol: url.protocol,
      hostnameHash: hashLogValue(url.hostname),
      port: url.port || null,
      isLoopback: LOOPBACK_HOSTS.has(url.hostname),
      hasPath: url.pathname !== "/" && url.pathname.length > 0,
      hasQuery: url.search.length > 0,
      targetLength: url.href.length,
    };
  } catch {
    return {
      targetType: "invalid-url",
      targetHash: hashLogValue(rawUrl),
      targetLength: rawUrl.length,
    };
  }
}

function pathLogMetadata(rawPath: unknown): Record<string, unknown> {
  if (typeof rawPath !== "string") {
    return { targetType: typeof rawPath };
  }

  return {
    targetType: "path",
    targetHash: hashLogValue(rawPath),
    targetLength: rawPath.length,
    extension: pathExtension(rawPath),
    isAbsolute: isProbablyAbsolutePath(rawPath),
  };
}

function pathExtension(rawPath: string): string {
  const normalized = rawPath.replaceAll("\\", "/");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  const dotIndex = basename.lastIndexOf(".");
  return dotIndex > 0 ? basename.slice(dotIndex).toLowerCase() : "";
}

function isProbablyAbsolutePath(rawPath: string): boolean {
  return rawPath.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(rawPath) || rawPath.startsWith("\\\\");
}

function listXdgDataDirectories(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const homeDataDirectory = env.XDG_DATA_HOME?.trim() || `${homedir()}/.local/share`;
  const sharedDataDirectories = (env.XDG_DATA_DIRS?.trim() || "/usr/local/share:/usr/share")
    .split(":")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return [homeDataDirectory, ...sharedDataDirectories];
}

function listDesktopEntryCandidates(
  desktopEntryId: string,
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  if (!DESKTOP_ENTRY_ID_PATTERN.test(desktopEntryId) || desktopEntryId.includes("..")) {
    return [];
  }

  return listXdgDataDirectories(env).map(
    (dataDirectory) => `${dataDirectory.replace(/\/+$/u, "")}/applications/${desktopEntryId}`,
  );
}

function commandOutput(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  command: string,
  args: readonly string[],
): Effect.Effect<Option.Option<string>> {
  return spawner
    .string(
      ChildProcess.make(command, args, {
        shell: false,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        killSignal: "SIGTERM",
        forceKillAfter: EXTERNAL_LAUNCH_KILL_GRACE,
      }),
    )
    .pipe(
      Effect.timeoutOption(EXTERNAL_LAUNCH_TIMEOUT),
      Effect.map((maybeOutput) =>
        Option.match(maybeOutput, {
          onNone: () => Option.none<string>(),
          onSome: (output) => {
            const trimmed = output.trim();
            return trimmed.length > 0 ? Option.some(trimmed) : Option.none<string>();
          },
        }),
      ),
      Effect.catch(() => Effect.succeed(Option.none<string>())),
    );
}

function commandExitZero(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  command: string,
  args: readonly string[],
): Effect.Effect<boolean> {
  return spawner
    .exitCode(
      ChildProcess.make(command, args, {
        shell: false,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        killSignal: "SIGTERM",
        forceKillAfter: EXTERNAL_LAUNCH_KILL_GRACE,
      }),
    )
    .pipe(
      Effect.timeoutOption(EXTERNAL_LAUNCH_TIMEOUT),
      Effect.map(
        (exitCode) => Option.isSome(exitCode) && exitCode.value === ChildProcessSpawner.ExitCode(0),
      ),
      Effect.catch(() => Effect.succeed(false)),
    );
}

function openWithLinuxDefaultBrowserDesktopEntry(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  externalUrl: string,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    if (!isCommandAvailable("xdg-settings") || !isCommandAvailable("gio")) {
      return false;
    }

    const desktopEntryId = yield* commandOutput(spawner, "xdg-settings", [
      "get",
      "default-web-browser",
    ]);
    if (Option.isNone(desktopEntryId)) {
      return false;
    }

    const candidates = listDesktopEntryCandidates(desktopEntryId.value);
    for (const candidate of candidates) {
      if (yield* commandExitZero(spawner, "gio", ["launch", candidate, externalUrl])) {
        yield* logInfo("default browser desktop entry launched", {
          desktopEntryId: desktopEntryId.value,
        });
        return true;
      }
    }

    yield* logWarning("default browser desktop entry launch failed", {
      desktopEntryId: desktopEntryId.value,
      candidateCount: candidates.length,
    });
    return false;
  });
}

function openWithElectronShell(externalUrl: string): Effect.Effect<boolean> {
  return Effect.promise(() =>
    Electron.shell.openExternal(externalUrl).then(
      () => true,
      () => false,
    ),
  );
}

export interface ElectronShellShape {
  readonly openExternal: (rawUrl: unknown) => Effect.Effect<boolean>;
  readonly openPath: (rawPath: unknown) => Effect.Effect<boolean>;
  readonly revealPath: (rawPath: unknown) => Effect.Effect<boolean>;
  readonly copyText: (text: string) => Effect.Effect<void>;
}

export class ElectronShell extends Context.Service<ElectronShell, ElectronShellShape>()(
  "cafecode/desktop/electron/Shell",
) {}

const make = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  ElectronShell.of({
    openExternal: (rawUrl) =>
      Option.match(parseSafeExternalUrl(rawUrl), {
        onNone: () =>
          logWarning("blocked external URL open", externalUrlLogMetadata(rawUrl)).pipe(
            Effect.as(false),
          ),
        onSome: (externalUrl) =>
          Effect.gen(function* () {
            const metadata = externalUrlLogMetadata(externalUrl);
            if (process.platform === "linux" && isLoopbackHttpUrl(externalUrl)) {
              yield* logInfo("opening loopback URL via default browser desktop entry", metadata);
              const launched = yield* openWithLinuxDefaultBrowserDesktopEntry(spawner, externalUrl);
              if (launched) {
                yield* logInfo("loopback URL open completed", metadata);
                return true;
              }
              yield* logWarning("loopback URL direct launch unavailable; falling back", metadata);
            }

            yield* logInfo("opening external URL via Electron shell", metadata);
            const opened = yield* openWithElectronShell(externalUrl);
            if (opened) {
              yield* logInfo("external URL open completed", metadata);
            } else {
              yield* logWarning("external URL open failed", metadata);
            }
            return opened;
          }),
      }),
    openPath: (rawPath) =>
      Effect.gen(function* () {
        if (typeof rawPath !== "string" || rawPath.length === 0 || rawPath.includes("\0")) {
          yield* logWarning("blocked path open", pathLogMetadata(rawPath));
          return false;
        }

        const metadata = pathLogMetadata(rawPath);
        yield* logInfo("opening path via Electron shell", metadata);
        const opened = yield* Effect.promise(() =>
          Electron.shell.openPath(rawPath).then(
            (errorMessage) => errorMessage.length === 0,
            () => false,
          ),
        );
        if (opened) {
          yield* logInfo("path open completed", metadata);
        } else {
          yield* logWarning("path open failed", metadata);
        }
        return opened;
      }),
    revealPath: (rawPath) =>
      Effect.gen(function* () {
        if (typeof rawPath !== "string" || rawPath.length === 0 || rawPath.includes("\0")) {
          yield* logWarning("blocked path reveal", pathLogMetadata(rawPath));
          return false;
        }

        const metadata = pathLogMetadata(rawPath);
        yield* logInfo("revealing path via Electron shell", metadata);
        const revealed = yield* Effect.sync(() => {
          try {
            Electron.shell.showItemInFolder(rawPath);
            return true;
          } catch {
            return false;
          }
        });
        if (revealed) {
          yield* logInfo("path reveal completed", metadata);
        } else {
          yield* logWarning("path reveal failed", metadata);
        }
        return revealed;
      }),
    copyText: (text) =>
      Effect.sync(() => {
        Electron.clipboard.writeText(text);
      }),
  });

export const layer = Layer.effect(
  ElectronShell,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return make(spawner);
  }),
);
