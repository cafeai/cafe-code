#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const gracefulShutdownMs = 5_000;
const require = createRequire(import.meta.url);
const desktopScriptsDirectory = dirname(fileURLToPath(import.meta.url));

export function resolveDevelopmentInvocation(script) {
  if (script === "dev:electron") {
    return {
      command: process.execPath,
      args: [resolve(desktopScriptsDirectory, "dev-electron.mjs")],
    };
  }

  if (script === "dev:bundle") {
    const packagePath = require.resolve("tsdown/package.json");
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
    const binaryPath = packageJson.bin?.tsdown;
    if (typeof binaryPath !== "string") {
      throw new Error("The locked tsdown package does not expose its expected executable.");
    }
    return {
      command: process.execPath,
      args: [resolve(dirname(packagePath), binaryPath), "--watch"],
    };
  }

  throw new Error(`Unsupported desktop development child '${script}'.`);
}

function signalProcessTree(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null || typeof child.pid !== "number") {
    return;
  }

  if (process.platform === "win32") {
    if (signal === "SIGKILL") {
      spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        shell: false,
      });
    } else {
      child.kill(signal);
    }
    return;
  }

  // The child scripts have their own graceful shutdown handlers. Signal their
  // immediate children as well so a package-manager wrapper cannot outlive the
  // supervisor if it exits before forwarding the signal.
  spawnSync("pkill", [`-${signal.replace("SIG", "")}`, "-P", String(child.pid)], {
    stdio: "ignore",
    shell: false,
  });
  child.kill(signal);
}

export function runDesktopDevelopment({
  scripts = ["dev:bundle", "dev:electron"],
  environment = process.env,
} = {}) {
  const children = new Set();
  const childExitPromises = [];
  let shuttingDown = false;
  let forced = false;

  const forceShutdown = (exitCode) => {
    if (forced) return;
    forced = true;
    for (const child of children) signalProcessTree(child, "SIGKILL");
    process.exit(exitCode);
  };

  const shutdown = async (exitCode) => {
    if (shuttingDown) {
      forceShutdown(exitCode);
      return;
    }
    shuttingDown = true;

    for (const child of children) signalProcessTree(child, "SIGTERM");

    let timeout;
    const timedOut = new Promise((resolve) => {
      timeout = setTimeout(() => resolve(true), gracefulShutdownMs);
      timeout.unref();
    });
    const cleanExit = Promise.all(childExitPromises).then(() => false);
    if (await Promise.race([cleanExit, timedOut])) {
      forceShutdown(exitCode);
      return;
    }
    clearTimeout(timeout);
    process.exit(exitCode);
  };

  for (const script of scripts) {
    const invocation = resolveDevelopmentInvocation(script);
    const child = spawn(invocation.command, invocation.args, {
      cwd: process.cwd(),
      env: environment,
      // Stay in Turbo's process group so its terminal shutdown reaches the
      // whole development tree even if the supervisor itself is force-killed.
      detached: false,
      stdio: "inherit",
      shell: false,
    });
    children.add(child);
    childExitPromises.push(
      new Promise((resolve) => {
        child.once("exit", resolve);
      }),
    );
    child.once("error", (error) => {
      process.stderr.write(`Desktop development child '${script}' failed: ${String(error)}\n`);
      void shutdown(1);
    });
    child.once("exit", (code, signal) => {
      if (shuttingDown) return;
      const exitCode = typeof code === "number" && code !== 0 ? code : signal ? 1 : 0;
      void shutdown(exitCode);
    });
  }

  process.once("SIGINT", () => void shutdown(130));
  process.once("SIGTERM", () => void shutdown(143));
  process.once("SIGHUP", () => void shutdown(129));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDesktopDevelopment();
}
