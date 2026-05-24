// @effect-diagnostics nodeBuiltinImport:off
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import packageJson from "../package.json" with { type: "json" };

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");
const packageServerBin = join(packageRoot, "dist", "bin.mjs");
const stagedDesktopScript = join(
  packageRoot,
  "dist",
  "apps",
  "desktop",
  "scripts",
  "start-electron.mjs",
);
const repoDesktopScript = join(repoRoot, "apps", "desktop", "scripts", "start-electron.mjs");

const serverSubcommands = new Set(["start", "serve", "auth", "project"]);

export type LaunchAction =
  | {
      readonly type: "desktop";
      readonly args: readonly string[];
    }
  | {
      readonly type: "server";
      readonly args: readonly string[];
    }
  | {
      readonly type: "help";
    }
  | {
      readonly type: "version";
    };

export function resolveLaunchAction(args: readonly string[]): LaunchAction {
  const firstArg = args[0];

  if (firstArg === "--version" || firstArg === "-v") {
    return { type: "version" };
  }

  if (firstArg === "--help" || firstArg === "-h") {
    return { type: "help" };
  }

  if (firstArg === "--server") {
    return { type: "server", args: args.slice(1) };
  }

  if (firstArg !== undefined && serverSubcommands.has(firstArg)) {
    return { type: "server", args };
  }

  return { type: "desktop", args };
}

export function buildDesktopLaunchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnv = { ...env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.CAFE_CODE_DESKTOP_DEV;
  delete childEnv.VITE_DEV_SERVER_URL;
  delete childEnv.CAFE_CODE_DEV_URL;
  return childEnv;
}

function resolveExecutableUrl(filePath: string): string {
  try {
    return pathToFileURL(realpathSync(filePath)).href;
  } catch {
    return pathToFileURL(filePath).href;
  }
}

export function isCliEntrypoint(
  entrypoint: string | undefined,
  moduleUrl = import.meta.url,
): boolean {
  if (entrypoint === undefined) {
    return false;
  }

  return moduleUrl === resolveExecutableUrl(entrypoint);
}

function printHelp() {
  process.stdout.write(`Cafe Code ${packageJson.version}

Usage:
  cafe-code                 Launch the Electron desktop app
  cafe-code --server <args> Run the server CLI
  cafe-code-server <args>   Run the server CLI

Common server example:
  cafe-code --server serve --host 127.0.0.1 --port 3773
`);
}

function spawnNode(scriptPath: string, args: readonly string[], env = process.env) {
  const child = spawn(process.execPath, [scriptPath, ...args], {
    stdio: "inherit",
    env,
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });

  child.on("error", (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

function launchServer(args: readonly string[]) {
  if (!existsSync(packageServerBin)) {
    process.stderr.write(`Cafe Code server entrypoint is missing: ${packageServerBin}\n`);
    process.exit(1);
  }
  spawnNode(packageServerBin, args);
}

function launchDesktop(args: readonly string[]) {
  const scriptPath = existsSync(stagedDesktopScript) ? stagedDesktopScript : repoDesktopScript;
  if (!existsSync(scriptPath)) {
    process.stderr.write(
      "Cafe Code desktop runtime is missing. Reinstall the package or run the desktop build first.\n",
    );
    process.exit(1);
  }

  spawnNode(scriptPath, args, buildDesktopLaunchEnv(process.env));
}

export function runLauncher(args: readonly string[]) {
  const action = resolveLaunchAction(args);

  switch (action.type) {
    case "version": {
      process.stdout.write(`${packageJson.version}\n`);
      process.exit(0);
    }
    case "help": {
      printHelp();
      process.exit(0);
    }
    case "server": {
      launchServer(action.args);
      break;
    }
    case "desktop": {
      launchDesktop(action.args);
      break;
    }
  }
}

function isDirectCliExecution() {
  return isCliEntrypoint(process.argv[1]);
}

if (isDirectCliExecution()) {
  runLauncher(process.argv.slice(2));
}
