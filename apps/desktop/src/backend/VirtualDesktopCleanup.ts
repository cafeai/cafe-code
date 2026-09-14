// @effect-diagnostics nodeBuiltinImport:off
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { desktopRuntimeDirectory, isDesktopIncarnationName } from "@cafecode/shared/desktopRuntime";

const birth = async (pid: number) => {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
};

/** Recovery for explicit Quit and stop when the provider owner is unavailable.
 * Authenticate to each private worker instead of killing by name or stale PID.
 * Watchdog restarts and background exits must never invoke this function. */
export async function stopDesktopWorkers(
  stateDir: string,
  backendEntryPath: string,
): Promise<boolean> {
  if (process.platform !== "linux") return true;
  const uid = process.getuid!(),
    root = desktopRuntimeDirectory(stateDir, uid);
  const privateDirectory = async (directory: string) => {
    const info = await fs.lstat(directory);
    return (
      info.isDirectory() && !info.isSymbolicLink() && info.uid === uid && (info.mode & 0o077) === 0
    );
  };
  try {
    if (!(await privateDirectory(root))) return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  const helper = path
    .join(path.dirname(backendEntryPath), "cafe-desktop-native")
    .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  const call = (bootstrap: string, method: string): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const child = execFile(
        helper,
        ["request", bootstrap],
        { encoding: "utf8", timeout: 4000, maxBuffer: 4096, shell: false },
        (error, stdout) => {
          if (error) {
            reject(new Error("Desktop cleanup unavailable."));
            return;
          }
          try {
            resolve(JSON.parse(stdout));
          } catch {
            reject(new Error("Desktop cleanup unavailable."));
          }
        },
      );
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(JSON.stringify({ method }) + "\n");
    });
  const directories = (await fs.readdir(root)).filter(isDesktopIncarnationName).slice(0, 64);
  let complete = true;
  for (let offset = 0; offset < directories.length; offset += 4) {
    const results = await Promise.all(
      directories.slice(offset, offset + 4).map(async (name) => {
        try {
          const directory = path.join(root, name);
          if (!(await privateDirectory(directory))) return false;
          const bootstrap = path.join(directory, "bootstrap.json");
          const status = await call(bootstrap, "status");
          if (
            !status.ok ||
            typeof status.pid !== "number" ||
            !Number.isSafeInteger(status.pid) ||
            status.pid <= 1 ||
            status.pid === process.pid
          )
            return false;
          const initial = await birth(status.pid);
          if (!initial) return true;
          await call(bootstrap, "terminate");
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            if ((await birth(status.pid)) !== initial) return true;
            await new Promise<void>((resolve) => setTimeout(resolve, 50));
          }
          return false;
        } catch {
          return false;
        }
      }),
    );
    if (results.some((ok) => !ok)) complete = false;
  }
  return complete;
}
