import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { desktopDir, resolveElectronPath } from "./electron-launcher.mjs";
import { linuxSafeStorageElectronArgs } from "./linux-safe-storage.mjs";

const isolateChildProcessGroup = process.platform !== "win32";
const forcedShutdownTimeoutMs = 5_000;

const ELECTRON_ONLY_ARGS = new Set(["--cafe-debug", "--debug"]);

function hasServerModeArg(args) {
  return args.some(
    (arg, index) => arg === "--mode" || arg.startsWith("--mode=") || args[index - 1] === "--mode",
  );
}

export function buildDesktopChildEnv(env) {
  const childEnv = { ...env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.CAFE_CODE_DESKTOP_DEV;
  delete childEnv.VITE_DEV_SERVER_URL;
  delete childEnv.CAFE_CODE_DEV_URL;
  return childEnv;
}

export function hasDisplayServer(environment, platform = process.platform) {
  if (platform !== "linux") {
    return true;
  }

  return Boolean(environment.DISPLAY?.trim() || environment.WAYLAND_DISPLAY?.trim());
}

export function resolveHeadlessServerEntrypoint(
  runtimeDesktopDir = desktopDir,
  pathExists = existsSync,
) {
  const serverEntrypoint = resolve(runtimeDesktopDir, "../server/dist/bin.mjs");
  return pathExists(serverEntrypoint) ? serverEntrypoint : undefined;
}

export function resolveHeadlessServerArgs(args) {
  const serverArgs = args.filter((arg) => !ELECTRON_ONLY_ARGS.has(arg));
  return ["serve", ...(hasServerModeArg(serverArgs) ? [] : ["--mode", "desktop"]), ...serverArgs];
}

export function resolveHeadlessServerCwd({ cwd, environment, runtimeDesktopDir = desktopDir }) {
  const initCwd = environment.INIT_CWD?.trim();
  if (initCwd && resolve(initCwd) === initCwd) {
    return initCwd;
  }

  return resolve(cwd) === resolve(runtimeDesktopDir) ? resolve(runtimeDesktopDir, "../..") : cwd;
}

export function resolveLaunchPlan({
  args,
  environment,
  platform = process.platform,
  runtimeDesktopDir = desktopDir,
  cwd = process.cwd(),
  electronPath = resolveElectronPath,
  serverEntrypoint = resolveHeadlessServerEntrypoint(runtimeDesktopDir),
}) {
  if (!hasDisplayServer(environment, platform)) {
    return {
      type: "headless-server",
      command: process.execPath,
      args:
        serverEntrypoint === undefined
          ? []
          : [serverEntrypoint, ...resolveHeadlessServerArgs(args)],
      cwd: resolveHeadlessServerCwd({ cwd, environment, runtimeDesktopDir }),
      serverEntrypoint,
    };
  }

  return {
    type: "electron",
    command: electronPath(),
    args: [...linuxSafeStorageElectronArgs(environment), "dist-electron/main.cjs", ...args],
    cwd: runtimeDesktopDir,
    serverEntrypoint: undefined,
  };
}

function spawnLaunchPlan(plan, childEnv) {
  if (plan.type === "headless-server") {
    if (plan.serverEntrypoint === undefined && plan.args.length === 0) {
      console.error(
        [
          "Cafe Code detected no Linux display server, but the headless server bundle is missing.",
          `Expected server entrypoint: ${resolve(desktopDir, "../server/dist/bin.mjs")}`,
          "Run bun run build:desktop first, or start the server directly with bun start.",
        ].join("\n"),
      );
      process.exit(1);
    }

    console.error("No Linux display server detected; starting Cafe Code in headless server mode.");
  }

  return spawn(plan.command, plan.args, {
    stdio: "inherit",
    cwd: plan.cwd,
    env: childEnv,
    detached: isolateChildProcessGroup,
  });
}

export function runStartElectron({
  args = process.argv.slice(2),
  environment = process.env,
  cwd = process.cwd(),
} = {}) {
  const childEnv = buildDesktopChildEnv(environment);
  const plan = resolveLaunchPlan({ args, environment: childEnv, cwd });
  const child = spawnLaunchPlan(plan, childEnv);

  let shuttingDown = false;
  let forcedShutdownTimer = null;
  let requestedShutdownExitCode = 0;

  function killChildProcessGroup(signal) {
    if (!isolateChildProcessGroup || typeof child.pid !== "number") {
      child.kill(signal);
      return;
    }

    try {
      process.kill(-child.pid, signal);
    } catch {
      // Ignore races with child processes that already exited.
    }
  }

  function requestShutdown(signal, exitCode) {
    if (shuttingDown) {
      killChildProcessGroup("SIGKILL");
      return;
    }

    shuttingDown = true;
    requestedShutdownExitCode = exitCode;
    child.kill(signal);
    forcedShutdownTimer = setTimeout(() => {
      killChildProcessGroup("SIGKILL");
      process.exit(exitCode);
    }, forcedShutdownTimeoutMs);
  }

  child.on("exit", (code, signal) => {
    if (forcedShutdownTimer !== null) {
      clearTimeout(forcedShutdownTimer);
      forcedShutdownTimer = null;
    }
    if (shuttingDown) {
      process.exit(code ?? requestedShutdownExitCode);
    }
    if (signal) {
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });

  process.on("SIGINT", () => {
    requestShutdown("SIGINT", 130);
  });
  process.on("SIGTERM", () => {
    requestShutdown("SIGTERM", 143);
  });
  process.on("SIGHUP", () => {
    requestShutdown("SIGHUP", 129);
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runStartElectron();
}
