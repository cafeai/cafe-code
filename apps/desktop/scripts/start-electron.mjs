import { spawn } from "node:child_process";

import { desktopDir, resolveElectronPath } from "./electron-launcher.mjs";

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
const isolateChildProcessGroup = process.platform !== "win32";
const forcedShutdownTimeoutMs = 5_000;

const child = spawn(resolveElectronPath(), ["dist-electron/main.cjs", ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: desktopDir,
  env: childEnv,
  detached: isolateChildProcessGroup,
});

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
    // Ignore races with Electron processes that already exited.
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
