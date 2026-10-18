#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalConsole:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalTimers:off
import { spawn } from "node:child_process";
import { closeSync, constants, mkdirSync, openSync } from "node:fs";
import { randomUUID } from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

import { DESKTOP_RESTART_EXISTING_FLAG } from "../apps/desktop/src/app/DesktopProfileControl.ts";
import { resolveDataProfileRoot } from "../packages/shared/src/dataProfile.ts";
import { prepareDebugDataProfile } from "../packages/shared/src/dataProfileStorage.ts";

export const DEFAULT_RESTART_WAIT_MS = 1_500;
export const DEFAULT_RESTART_DELAY_MS = 750;

export interface RestartCafeCodeArgs {
  readonly runHelper: boolean;
  readonly waitMs: number;
  readonly restartDelayMs: number;
  readonly logDir: string | undefined;
  readonly launchCommand: ReadonlyArray<string> | undefined;
  readonly dryRun: boolean;
  readonly help: boolean;
}

interface NormalizedRestartOptions extends RestartCafeCodeArgs {
  readonly repoRoot: string;
  readonly scriptPath: string;
  readonly resolvedLogDir: string;
  readonly configuredBaseDir: string;
}

const usage = `Usage:
  yarn restart:desktop [options] [-- command ...]

Schedules a detached Node helper that requests a restart through the Debug
profile's native single-instance owner. It never scans or terminates Production
processes. If no Debug owner exists, the same command starts Debug normally.
The source launch command is:
  node apps/desktop/scripts/start-electron-launchservices.mjs (macOS)
  node apps/desktop/scripts/start-electron.mjs (other hosts)

Options:
  --wait-ms <n>           Delay before requesting Debug restart (default: 1500)
  --restart-delay-ms <n>  Additional handoff delay (default: 750)
  --log-dir <path>        Restart log directory (default: $CAFE_CODE_HOME/.debug/restart-logs)
  --dry-run               Print what would be scheduled without starting helper
  --help                  Show this help

Examples:
  yarn restart:desktop

Custom replacement commands after -- are refused. Close the selected Debug
profile explicitly before starting a different development launcher. The global
killall command remains a separate, explicitly global emergency operation.
`;

function parseIntegerFlag(value: string | undefined, flag: string): number {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Missing value for ${flag}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${flag}: expected a non-negative integer.`);
  }
  return parsed;
}

function readFlagValue(args: ReadonlyArray<string>, index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

export function parseRestartCafeCodeArgs(args: ReadonlyArray<string>): RestartCafeCodeArgs {
  let runHelper = false;
  let waitMs = DEFAULT_RESTART_WAIT_MS;
  let restartDelayMs = DEFAULT_RESTART_DELAY_MS;
  let logDir: string | undefined;
  let launchCommand: ReadonlyArray<string> | undefined;
  let dryRun = false;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      launchCommand = args.slice(index + 1);
      if (launchCommand.length === 0) {
        throw new Error("Expected a launch command after --.");
      }
      break;
    }

    if (arg === "--run-helper") {
      runHelper = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (arg === "--wait-ms") {
      waitMs = parseIntegerFlag(readFlagValue(args, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg?.startsWith("--wait-ms=")) {
      waitMs = parseIntegerFlag(arg.slice("--wait-ms=".length), "--wait-ms");
      continue;
    }

    if (arg === "--restart-delay-ms") {
      restartDelayMs = parseIntegerFlag(readFlagValue(args, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg?.startsWith("--restart-delay-ms=")) {
      restartDelayMs = parseIntegerFlag(
        arg.slice("--restart-delay-ms=".length),
        "--restart-delay-ms",
      );
      continue;
    }

    if (arg === "--log-dir") {
      logDir = readFlagValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg?.startsWith("--log-dir=")) {
      logDir = arg.slice("--log-dir=".length);
      continue;
    }

    throw new Error(`Unknown option: ${String(arg)}`);
  }

  return {
    runHelper,
    waitMs,
    restartDelayMs,
    logDir,
    launchCommand,
    dryRun,
    help,
  };
}

export function defaultLaunchCommand(
  nodePath = process.execPath,
  platform: NodeJS.Platform = process.platform,
): ReadonlyArray<string> {
  return [
    nodePath,
    platform === "darwin"
      ? "apps/desktop/scripts/start-electron-launchservices.mjs"
      : "apps/desktop/scripts/start-electron.mjs",
  ];
}

/**
 * Native relaunch preserves the exact existing owner's launch configuration.
 * An arbitrary replacement command cannot be authorized by that receipt. Fail
 * before scheduling any helper instead of recovering with a global killall.
 */
export function profileRestartCommand(input: {
  readonly launchCommand: ReadonlyArray<string> | undefined;
  readonly nodePath?: string;
  readonly platform?: NodeJS.Platform;
}): ReadonlyArray<string> {
  if (input.launchCommand !== undefined) {
    throw new Error(
      "Custom launch commands cannot be used for a profile-scoped restart. Close that Debug profile explicitly before starting a different launcher.",
    );
  }
  return [
    ...defaultLaunchCommand(input.nodePath ?? process.execPath, input.platform ?? process.platform),
    DESKTOP_RESTART_EXISTING_FLAG,
  ];
}

export function resolveRestartLogDir(input: {
  readonly explicitLogDir: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly homeDir: string;
  readonly cwd: string;
}): string {
  const configured = input.explicitLogDir?.trim();
  if (configured) {
    return NodePath.resolve(input.cwd, configured);
  }

  const configuredBaseDir = NodePath.resolve(
    input.cwd,
    input.env.CAFE_CODE_HOME?.trim() || NodePath.join(input.homeDir, ".cafe-code"),
  );
  const effectiveRoot = resolveDataProfileRoot(configuredBaseDir, "debug", NodePath);
  return NodePath.join(effectiveRoot, "restart-logs");
}

/** A new private file, never an append/reopen of a pre-existing path alias. */
export function openRestartLog(path: string): number {
  try {
    return openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch {
    throw new Error(
      "Unable to create a private Debug restart log. Existing files and Production data were preserved.",
    );
  }
}

export function buildHelperProcessArgs(input: {
  readonly scriptPath: string;
  readonly waitMs: number;
  readonly restartDelayMs: number;
  readonly logDir: string;
  readonly launchCommand: ReadonlyArray<string> | undefined;
}): ReadonlyArray<string> {
  const args = [
    input.scriptPath,
    "--run-helper",
    "--wait-ms",
    String(input.waitMs),
    "--restart-delay-ms",
    String(input.restartDelayMs),
    "--log-dir",
    input.logDir,
  ];

  if (input.launchCommand !== undefined) {
    args.push("--", ...input.launchCommand);
  }

  return args;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/gu, "-");
}

function commandSummary(command: ReadonlyArray<string>): string {
  if (command.length === 0) {
    return "(empty command)";
  }
  const [executable, ...args] = command;
  return `${String(executable)} (${args.length} arg${args.length === 1 ? "" : "s"})`;
}

function spawnDetached(command: ReadonlyArray<string>, cwd: string): void {
  const [executable, ...args] = command;
  if (executable === undefined) {
    throw new Error("Cannot spawn an empty command.");
  }

  const child = spawn(executable, args, {
    cwd,
    // The sole executable is the current native Node, including on Windows.
    // No shell or batch-command resolution is needed for this fixed request.
    shell: false,
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
  });
  child.unref();
}

function normalizeOptions(args: RestartCafeCodeArgs): NormalizedRestartOptions {
  profileRestartCommand({ launchCommand: args.launchCommand });
  const scriptPath = fileURLToPath(import.meta.url);
  const repoRoot = NodePath.resolve(NodePath.dirname(scriptPath), "..");
  const resolvedLogDir = resolveRestartLogDir({
    explicitLogDir: args.logDir,
    env: process.env,
    homeDir: NodeOS.homedir(),
    cwd: repoRoot,
  });
  const configuredBaseDir = NodePath.resolve(
    repoRoot,
    process.env.CAFE_CODE_HOME?.trim() || NodePath.join(NodeOS.homedir(), ".cafe-code"),
  );
  return {
    ...args,
    repoRoot,
    scriptPath,
    resolvedLogDir,
    configuredBaseDir,
  };
}

async function scheduleRestart(options: NormalizedRestartOptions): Promise<void> {
  const logPath = NodePath.join(
    options.resolvedLogDir,
    `restart-${formatTimestamp()}-${process.pid}-${randomUUID()}.log`,
  );
  const helperArgs = buildHelperProcessArgs({
    scriptPath: options.scriptPath,
    waitMs: options.waitMs,
    restartDelayMs: options.restartDelayMs,
    logDir: options.resolvedLogDir,
    launchCommand: options.launchCommand,
  });

  if (options.dryRun) {
    const launchCommand = profileRestartCommand(options);
    console.log("Cafe Code restart dry run.");
    console.log(`helper: ${process.execPath} (${helperArgs.length} args)`);
    console.log(`launch: ${commandSummary(launchCommand)}`);
    console.log(`log: ${logPath}`);
    return;
  }

  if (options.logDir?.trim()) {
    // This is an explicit operator-selected destination, not an inferred
    // Production path. Existing log files still cannot be followed/reused.
    mkdirSync(options.resolvedLogDir, { recursive: true, mode: 0o700 });
  } else {
    // Admit the Debug root and fixed restart-log directory before opening any
    // default log. A .debug/restart-logs alias cannot redirect output to release.
    await prepareDebugDataProfile(options.configuredBaseDir);
  }
  const logFd = openRestartLog(logPath);

  try {
    const helper = spawn(process.execPath, helperArgs, {
      cwd: options.repoRoot,
      env: {
        ...process.env,
      },
      stdio: ["ignore", logFd, logFd],
      detached: true,
    });
    helper.unref();
  } finally {
    closeSync(logFd);
  }

  console.log(`Scheduled Cafe Code restart helper. Log: ${logPath}`);
}

async function runHelper(options: NormalizedRestartOptions): Promise<void> {
  const launchCommand = profileRestartCommand(options);

  console.log(`[restart] helper pid=${process.pid}`);
  console.log(`[restart] waitMs=${options.waitMs} restartDelayMs=${options.restartDelayMs}`);
  console.log(`[restart] launch=${commandSummary(launchCommand)}`);

  await sleep(options.waitMs);

  await sleep(options.restartDelayMs);
  spawnDetached(launchCommand, options.repoRoot);
  console.log(
    "[restart] Debug profile restart request spawned; the native owner controls shutdown.",
  );
}

async function main(): Promise<void> {
  const args = parseRestartCafeCodeArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage);
    return;
  }

  const options = normalizeOptions(args);
  if (options.runHelper) {
    await runHelper(options);
    return;
  }

  await scheduleRestart(options);
}

if (import.meta.main) {
  main().catch((cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(`[restart] ${message}`);
    process.exitCode = 1;
  });
}
