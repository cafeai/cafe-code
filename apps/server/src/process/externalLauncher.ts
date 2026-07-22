/**
 * ExternalLauncher - external application launch service interface.
 *
 * Owns process launch helpers for browser URLs and workspace paths
 * in configured editor integrations.
 *
 * @module ExternalLauncher
 */
import {
  EDITORS,
  ExternalLauncherError,
  type EditorId,
  type LaunchEditorInput,
  type LaunchTerminalInput,
  type TerminalAvailability,
} from "@cafecode/contracts";
import {
  hostDesktopLaunchEnvironment,
  isCommandAvailable,
  type CommandAvailabilityOptions,
} from "@cafecode/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

// ==============================
// Definitions
// ==============================

export { ExternalLauncherError };
export type { LaunchEditorInput };
export { isCommandAvailable } from "@cafecode/shared/shell";

interface EditorLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

interface TerminalLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
}

interface ProcessLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: ChildProcess.CommandOptions;
}

interface TargetPathAndPosition {
  readonly path: string;
  readonly line: string;
  readonly column: Option.Option<string>;
}

export type CommandAvailabilityProbe = (
  command: string,
  options?: CommandAvailabilityOptions,
) => boolean;

const TARGET_WITH_POSITION_PATTERN = /^(.*?):(\d+)(?::(\d+))?$/;
const POWERSHELL_ARGUMENTS_PREFIX = [
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-EncodedCommand",
] as const;

const DETACHED_IGNORE_STDIO_OPTIONS = {
  detached: true,
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
} as const satisfies ChildProcess.CommandOptions;

function detachedDesktopProcessOptions(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): ChildProcess.CommandOptions {
  return {
    ...DETACHED_IGNORE_STDIO_OPTIONS,
    ...(platform === "linux"
      ? {
          env: hostDesktopLaunchEnvironment(env, platform),
          extendEnv: false,
        }
      : {}),
  };
}

function parseTargetPathAndPosition(target: string): Option.Option<TargetPathAndPosition> {
  const match = TARGET_WITH_POSITION_PATTERN.exec(target);
  if (!match?.[1] || !match[2]) {
    return Option.none();
  }

  return Option.some({
    path: match[1],
    line: match[2],
    column: Option.fromUndefinedOr(match[3]),
  });
}

function resolveCommandEditorArgs(
  editor: (typeof EDITORS)[number],
  target: string,
): ReadonlyArray<string> {
  const parsedTarget = parseTargetPathAndPosition(target);

  switch (editor.launchStyle) {
    case "direct-path":
      return [target];
    case "goto":
      return Option.isSome(parsedTarget) ? ["--goto", target] : [target];
    case "line-column":
      return Option.match(parsedTarget, {
        onNone: () => [target],
        onSome: ({ path, line, column }) => [
          "--line",
          line,
          ...Option.match(column, {
            onNone: () => [],
            onSome: (value) => ["--column", value],
          }),
          path,
        ],
      });
  }
}

function resolveEditorArgs(
  editor: (typeof EDITORS)[number],
  target: string,
): ReadonlyArray<string> {
  const baseArgs = "baseArgs" in editor ? editor.baseArgs : [];
  return [...baseArgs, ...resolveCommandEditorArgs(editor, target)];
}

function resolveAvailableCommand(
  commands: ReadonlyArray<string>,
  options: CommandAvailabilityOptions = {},
  commandAvailable: CommandAvailabilityProbe = isCommandAvailable,
): Option.Option<string> {
  for (const command of commands) {
    if (commandAvailable(command, options)) {
      return Option.some(command);
    }
  }
  return Option.none();
}

function encodeUtf16LeBase64(input: string): string {
  const bytes = new Uint8Array(input.length * 2);
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    bytes[index * 2] = code & 0xff;
    bytes[index * 2 + 1] = code >>> 8;
  }
  return Encoding.encodeBase64(bytes);
}

function escapePowerShellStringLiteral(input: string): string {
  return `'${input.replaceAll("'", "''")}'`;
}

function resolvePowerShellPath(env: NodeJS.ProcessEnv = process.env): string {
  return `${env.SYSTEMROOT || env.windir || String.raw`C:\Windows`}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

function resolveWslPowerShellPath(): string {
  return "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
}

function trimNonEmpty(input: string | undefined): string | undefined {
  const trimmed = input?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function splitTerminalCommand(input: string): { command: string; args: ReadonlyArray<string> } {
  const tokens = input.trim().split(/\s+/);
  return { command: tokens[0] ?? input, args: tokens.slice(1) };
}

function escapeAppleScriptStringLiteral(input: string): string {
  return input.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function shouldUseWindowsBrowserFromWsl(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    platform === "linux" &&
    (env.WSL_DISTRO_NAME !== undefined || env.WSL_INTEROP !== undefined) &&
    env.SSH_CONNECTION === undefined &&
    env.SSH_TTY === undefined &&
    env.container === undefined
  );
}

function resolveWindowsBrowserLaunch(target: string, command: string): ProcessLaunch {
  const encodedCommand = encodeUtf16LeBase64(
    `$ProgressPreference = 'SilentlyContinue'; Start ${escapePowerShellStringLiteral(target)}`,
  );
  return {
    command,
    args: [...POWERSHELL_ARGUMENTS_PREFIX, encodedCommand],
    options: {
      detached: true,
      shell: false,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    },
  };
}

function isKdeDesktop(env: NodeJS.ProcessEnv): boolean {
  if (env.KDE_FULL_SESSION === "true") {
    return true;
  }

  const desktopNames = [
    env.XDG_CURRENT_DESKTOP,
    env.XDG_SESSION_DESKTOP,
    env.DESKTOP_SESSION,
  ].flatMap((value) => value?.split(":") ?? []);
  return desktopNames.some((value) => {
    const normalized = value.trim().toLowerCase();
    return normalized === "kde" || normalized === "plasma";
  });
}

function fileManagerLaunchForPlatform(
  target: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  commandAvailable: CommandAvailabilityProbe = isCommandAvailable,
): EditorLaunch {
  switch (platform) {
    case "darwin":
      return { command: "open", args: [target] };
    case "win32":
      return { command: "explorer", args: [target] };
    default:
      if (platform === "linux") {
        // KDE can route xdg-open for directories through the desktop entry id
        // (for example org.kde.dolphin.desktop). In some source-launch
        // environments that id is then treated as an executable name, so prefer
        // the concrete Dolphin binary when Cafe is running in a KDE session.
        if (isKdeDesktop(env) && commandAvailable("dolphin", { platform, env })) {
          return { command: "dolphin", args: [target] };
        }
        if (commandAvailable("gio", { platform, env })) {
          return { command: "gio", args: ["open", target] };
        }
      }
      return { command: "xdg-open", args: [target] };
  }
}

export function resolveBrowserLaunch(
  target: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ProcessLaunch {
  if (platform === "darwin") {
    return {
      command: "open",
      args: [target],
      options: DETACHED_IGNORE_STDIO_OPTIONS,
    };
  }

  if (platform === "win32") {
    return resolveWindowsBrowserLaunch(target, resolvePowerShellPath(env));
  }

  if (shouldUseWindowsBrowserFromWsl(platform, env)) {
    return resolveWindowsBrowserLaunch(target, resolveWslPowerShellPath());
  }

  return {
    command: "xdg-open",
    args: [target],
    options: detachedDesktopProcessOptions(platform, env),
  };
}

export function resolveAvailableEditors(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  commandAvailable: CommandAvailabilityProbe = isCommandAvailable,
): ReadonlyArray<EditorId> {
  const available: EditorId[] = [];

  for (const editor of EDITORS) {
    if (editor.commands === null) {
      const { command } = fileManagerLaunchForPlatform("", platform, env, commandAvailable);
      if (commandAvailable(command, { platform, env })) {
        available.push(editor.id);
      }
      continue;
    }

    const command = resolveAvailableCommand(editor.commands, { platform, env }, commandAvailable);
    if (Option.isSome(command)) {
      available.push(editor.id);
    }
  }

  return available;
}

export function resolveTerminalAvailability(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): TerminalAvailability {
  if (platform === "linux") {
    const terminal = trimNonEmpty(env.TERMINAL);
    return terminal
      ? { available: true, label: terminal }
      : {
          available: false,
          label: "Terminal",
          unavailableReason: "$TERMINAL needs to be set.",
        };
  }

  if (platform === "win32") {
    return { available: true, label: "PowerShell" };
  }

  if (platform === "darwin") {
    return { available: true, label: "Terminal" };
  }

  return {
    available: false,
    label: "Terminal",
    unavailableReason: "Terminal launch is unavailable on this platform.",
  };
}

/**
 * ExternalLauncherShape - Service API for browser and editor launch actions.
 */
export interface ExternalLauncherShape {
  /**
   * Launch a URL target in the default browser.
   */
  readonly launchBrowser: (target: string) => Effect.Effect<void, ExternalLauncherError>;

  /**
   * Launch a workspace path in a selected editor integration.
   *
   * Launches the editor as a detached process so server startup is not blocked.
   */
  readonly launchEditor: (input: LaunchEditorInput) => Effect.Effect<void, ExternalLauncherError>;

  /**
   * Launch a terminal in a workspace directory.
   */
  readonly launchTerminal: (
    input: LaunchTerminalInput,
  ) => Effect.Effect<void, ExternalLauncherError>;
}

/**
 * ExternalLauncher - Service tag for browser/editor launch operations.
 */
export class ExternalLauncher extends Context.Service<ExternalLauncher, ExternalLauncherShape>()(
  "cafecode/process/ExternalLauncher",
) {}

// ==============================
// Implementations
// ==============================

export const resolveEditorLaunch = Effect.fn("resolveEditorLaunch")(function* (
  input: LaunchEditorInput,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  commandAvailable: CommandAvailabilityProbe = isCommandAvailable,
): Effect.fn.Return<EditorLaunch, ExternalLauncherError> {
  yield* Effect.annotateCurrentSpan({
    "externalLauncher.editor": input.editor,
    "externalLauncher.cwd": input.cwd,
    "externalLauncher.platform": platform,
  });
  const editorDef = EDITORS.find((editor) => editor.id === input.editor);
  if (!editorDef) {
    return yield* new ExternalLauncherError({ message: `Unknown editor: ${input.editor}` });
  }

  if (editorDef.commands) {
    const command = Option.getOrElse(
      resolveAvailableCommand(editorDef.commands, { platform, env }, commandAvailable),
      () => editorDef.commands[0],
    );
    return {
      command,
      args: resolveEditorArgs(editorDef, input.cwd),
    };
  }

  if (editorDef.id !== "file-manager") {
    return yield* new ExternalLauncherError({ message: `Unsupported editor: ${input.editor}` });
  }

  return fileManagerLaunchForPlatform(input.cwd, platform, env, commandAvailable);
});

export function resolveEditorProcessLaunch(
  launch: EditorLaunch,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ProcessLaunch {
  return {
    command: launch.command,
    args: [...launch.args],
    options: {
      ...detachedDesktopProcessOptions(platform, env),
      shell: false,
    },
  };
}

export const resolveTerminalLaunch = Effect.fn("resolveTerminalLaunch")(function* (
  input: LaunchTerminalInput,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<TerminalLaunch, ExternalLauncherError> {
  yield* Effect.annotateCurrentSpan({
    "externalLauncher.cwd": input.cwd,
    "externalLauncher.platform": platform,
  });

  if (platform === "linux") {
    const terminal = trimNonEmpty(env.TERMINAL);
    if (!terminal) {
      return yield* new ExternalLauncherError({ message: "$TERMINAL needs to be set." });
    }
    const { command, args } = splitTerminalCommand(terminal);
    return { command, args, cwd: input.cwd };
  }

  if (platform === "win32") {
    return { command: resolvePowerShellPath(env), args: ["-NoExit"], cwd: input.cwd };
  }

  if (platform === "darwin") {
    const cwd = escapeAppleScriptStringLiteral(input.cwd);
    return {
      command: "osascript",
      args: ["-e", `tell application "Terminal" to do script "cd \\"${cwd}\\""`],
      cwd: input.cwd,
    };
  }

  return yield* new ExternalLauncherError({
    message: "Terminal launch is unavailable on this platform.",
  });
});

export function resolveTerminalProcessLaunch(
  launch: TerminalLaunch,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ProcessLaunch {
  return {
    command: launch.command,
    args: [...launch.args],
    options: {
      cwd: launch.cwd,
      ...detachedDesktopProcessOptions(platform, env),
      shell: false,
    },
  };
}

const launchAndUnref = Effect.fn("externalLauncher.launchAndUnref")(function* (
  launch: ProcessLaunch,
  errorMessage: string,
): Effect.fn.Return<void, ExternalLauncherError, ChildProcessSpawner.ChildProcessSpawner> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = ChildProcess.make(launch.command, launch.args, launch.options);

  yield* spawner.spawn(command).pipe(
    Effect.flatMap((handle) => handle.unref),
    Effect.asVoid,
    Effect.scoped,
    Effect.mapError((cause) => new ExternalLauncherError({ message: errorMessage, cause })),
  );
});

export const launchBrowser = Effect.fn("externalLauncher.launchBrowser")(function* (
  target: string,
): Effect.fn.Return<void, ExternalLauncherError, ChildProcessSpawner.ChildProcessSpawner> {
  return yield* launchAndUnref(resolveBrowserLaunch(target), "Browser auto-open failed");
});

export const launchEditorProcess = Effect.fn("externalLauncher.launchEditorProcess")(function* (
  launch: EditorLaunch,
): Effect.fn.Return<void, ExternalLauncherError, ChildProcessSpawner.ChildProcessSpawner> {
  if (!isCommandAvailable(launch.command)) {
    return yield* new ExternalLauncherError({
      message: `Editor command not found: ${launch.command}`,
    });
  }

  yield* launchAndUnref(resolveEditorProcessLaunch(launch), "failed to spawn detached process");
});

export const launchTerminalProcess = Effect.fn("externalLauncher.launchTerminalProcess")(function* (
  launch: TerminalLaunch,
): Effect.fn.Return<void, ExternalLauncherError, ChildProcessSpawner.ChildProcessSpawner> {
  if (!isCommandAvailable(launch.command)) {
    return yield* new ExternalLauncherError({
      message: `Terminal command not found: ${launch.command}`,
    });
  }

  yield* launchAndUnref(resolveTerminalProcessLaunch(launch), "failed to spawn terminal process");
});

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  return {
    launchBrowser: (target) =>
      launchBrowser(target).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    launchEditor: (input) =>
      Effect.flatMap(resolveEditorLaunch(input), (launch) =>
        launchEditorProcess(launch).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      ),
    launchTerminal: (input) =>
      Effect.flatMap(resolveTerminalLaunch(input), (launch) =>
        launchTerminalProcess(launch).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      ),
  } satisfies ExternalLauncherShape;
});

export const layer = Layer.effect(ExternalLauncher, make);
