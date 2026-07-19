#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalConsole:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalTimers:off
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

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
}

const usage = `Usage:
  yarn restart:desktop [options] [-- command ...]

Schedules a detached Node helper that waits briefly, runs Cafe Code's killall entrypoint, then
relaunches Cafe Code. The default launch command is:
  node apps/desktop/scripts/start-electron.mjs

Options:
  --wait-ms <n>           Delay before killing the current app (default: 1500)
  --restart-delay-ms <n>  Delay between killall and relaunch (default: 750)
  --log-dir <path>        Restart log directory (default: $CAFE_CODE_HOME/restart-logs)
  --dry-run               Print what would be scheduled without starting helper
  --help                  Show this help

Examples:
  yarn restart:desktop
  yarn restart:desktop -- yarn dev:desktop
  yarn restart:desktop -- node apps/desktop/scripts/start-electron.mjs --cafe-debug
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

export function defaultLaunchCommand(nodePath = process.execPath): ReadonlyArray<string> {
  return [nodePath, "apps/desktop/scripts/start-electron.mjs"];
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

  const cafeHome = input.env.CAFE_CODE_HOME?.trim() || NodePath.join(input.homeDir, ".cafe-code");
  return NodePath.join(cafeHome, "restart-logs");
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

function spawnOptions(cwd: string): { readonly cwd: string; readonly shell: boolean } {
  return {
    cwd,
    shell: process.platform === "win32",
  };
}

async function runCommand(command: ReadonlyArray<string>, cwd: string): Promise<number> {
  const [executable, ...args] = command;
  if (executable === undefined) {
    throw new Error("Cannot run an empty command.");
  }

  return await new Promise<number>((resolve, reject) => {
    const child = spawn(executable, args, {
      ...spawnOptions(cwd),
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        resolve(128);
        return;
      }
      resolve(code ?? 0);
    });
  });
}

function spawnDetached(command: ReadonlyArray<string>, cwd: string): void {
  const [executable, ...args] = command;
  if (executable === undefined) {
    throw new Error("Cannot spawn an empty command.");
  }

  const child = spawn(executable, args, {
    ...spawnOptions(cwd),
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
  });
  child.unref();
}

function normalizeOptions(args: RestartCafeCodeArgs): NormalizedRestartOptions {
  const scriptPath = fileURLToPath(import.meta.url);
  const repoRoot = NodePath.resolve(NodePath.dirname(scriptPath), "..");
  const resolvedLogDir = resolveRestartLogDir({
    explicitLogDir: args.logDir,
    env: process.env,
    homeDir: NodeOS.homedir(),
    cwd: repoRoot,
  });
  return {
    ...args,
    repoRoot,
    scriptPath,
    resolvedLogDir,
  };
}

async function scheduleRestart(options: NormalizedRestartOptions): Promise<void> {
  const logPath = NodePath.join(
    options.resolvedLogDir,
    `restart-${formatTimestamp()}-${process.pid}.log`,
  );
  const helperArgs = buildHelperProcessArgs({
    scriptPath: options.scriptPath,
    waitMs: options.waitMs,
    restartDelayMs: options.restartDelayMs,
    logDir: options.resolvedLogDir,
    launchCommand: options.launchCommand,
  });

  if (options.dryRun) {
    const launchCommand = options.launchCommand ?? defaultLaunchCommand();
    console.log("Cafe Code restart dry run.");
    console.log(`helper: ${process.execPath} (${helperArgs.length} args)`);
    console.log(`launch: ${commandSummary(launchCommand)}`);
    console.log(`log: ${logPath}`);
    return;
  }

  mkdirSync(options.resolvedLogDir, { recursive: true });
  const outFd = openSync(logPath, "a");
  const errFd = openSync(logPath, "a");

  try {
    const helper = spawn(process.execPath, helperArgs, {
      cwd: options.repoRoot,
      env: {
        ...process.env,
      },
      stdio: ["ignore", outFd, errFd],
      detached: true,
    });
    helper.unref();
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }

  console.log(`Scheduled Cafe Code restart helper. Log: ${logPath}`);
}

async function runHelper(options: NormalizedRestartOptions): Promise<void> {
  const launchCommand = options.launchCommand ?? defaultLaunchCommand();
  const killallCommand = [process.execPath, "apps/server/src/bin.ts", "killall"];

  console.log(`[restart] helper pid=${process.pid}`);
  console.log(`[restart] waitMs=${options.waitMs} restartDelayMs=${options.restartDelayMs}`);
  console.log(`[restart] killall=${commandSummary(killallCommand)}`);
  console.log(`[restart] launch=${commandSummary(launchCommand)}`);

  await sleep(options.waitMs);

  const killallExitCode = await runCommand(killallCommand, options.repoRoot);
  console.log(`[restart] killall exited with code ${killallExitCode}`);
  if (killallExitCode !== 0) {
    process.exitCode = killallExitCode;
    return;
  }

  await sleep(options.restartDelayMs);
  spawnDetached(launchCommand, options.repoRoot);
  console.log("[restart] launch command spawned.");
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
