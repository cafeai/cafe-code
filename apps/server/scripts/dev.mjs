import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, watch } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sourceDebugBuildFingerprint } from "../../../packages/shared/src/sourceDebugBuild.ts";

const serverDirectory = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);

/** A development restart owns only its exact admitted child and joins native
 * close. Retirement fences queued builds before stopping that child. Source
 * receipts are rechecked after the await, before a replacement can start.
 */
export function createServerDevelopmentController({ start, qualify, stop }) {
  let retired = false;
  let current;
  let currentBuild;
  let queue = Promise.resolve();
  let closing;
  const built = () => {
    if (retired) return queue;
    queue = queue.then(async () => {
      if (retired) return;
      const before = qualify();
      if (!before || (current && currentBuild === before)) return;
      if (current) {
        const held = current;
        await stop(held);
        current = undefined;
      }
      const after = retired ? undefined : qualify();
      if (!retired && after) {
        current = start();
        currentBuild = after;
      }
    });
    return queue;
  };
  const close = () => {
    retired = true;
    if (closing) return closing;
    closing = queue
      .catch(() => undefined)
      .then(async () => {
        if (current) {
          const held = current;
          await stop(held);
          current = undefined;
        }
      });
    return closing;
  };
  return { built, close };
}

export async function runServerDevelopment(environment = process.env) {
  const dist = join(serverDirectory, "dist");
  const entry = join(dist, "bin.mjs");
  mkdirSync(dist, { recursive: true });
  const packagePath = require.resolve("tsdown/package.json");
  const binary = JSON.parse(readFileSync(packagePath, "utf8")).bin?.tsdown;
  if (typeof binary !== "string") throw new Error("The pinned backend compiler is unavailable.");
  const exits = new WeakMap();
  const admit = (command, args, options) => {
    const child = spawn(command, args, { shell: false, stdio: "inherit", ...options });
    const closed = new Promise((accept, reject) => {
      let error;
      child.once("error", (value) => {
        error = value;
      });
      child.once("close", (code) => (error ? reject(error) : accept(code)));
    });
    // Keep an observed result even if the compiler fails before close owns it.
    void closed.catch(() => undefined);
    exits.set(child, closed);
    return child;
  };
  const stop = async (child) => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 5_000);
    try {
      await exits.get(child);
    } finally {
      clearTimeout(timer);
    }
  };
  const controller = createServerDevelopmentController({
    qualify: () => {
      try {
        return sourceDebugBuildFingerprint(entry, "server");
      } catch {
        return undefined;
      }
    },
    start: () =>
      admit(process.execPath, [entry], {
        cwd: serverDirectory,
        env: { ...environment, CAFE_CODE_DATA_PROFILE: "debug" },
      }),
    stop,
  });
  let retired = false;
  let watcher;
  let compiler;
  let closing;
  const close = (exitCode) => {
    if (closing) return closing;
    retired = true;
    watcher?.close();
    closing = (async () => {
      try {
        await controller.close();
      } finally {
        try {
          if (compiler) await stop(compiler);
        } finally {
          process.exitCode = exitCode;
        }
      }
    })();
    return closing;
  };
  const fail = () => {
    console.error("Backend development stopped before a qualified runtime was available.");
    void close(1);
  };
  watcher = watch(dist, (_event, file) => {
    if (!retired && file === "bin.mjs.debug-profile.json") void controller.built().catch(fail);
  });
  compiler = admit(process.execPath, [resolve(dirname(packagePath), binary), "--watch"], {
    cwd: serverDirectory,
    env: environment,
  });
  void exits.get(compiler).then((code) => close(code ?? 1), fail);
  process.once("SIGINT", () => {
    void close(130);
  });
  process.once("SIGTERM", () => {
    void close(143);
  });
  process.once("SIGHUP", () => {
    void close(129);
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await runServerDevelopment();
