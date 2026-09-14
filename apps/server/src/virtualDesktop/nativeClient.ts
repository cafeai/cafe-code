// @effect-diagnostics nodeBuiltinImport:off
import { spawn, execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { VirtualDesktopError } from "@cafecode/contracts";

export function desktopError(code: VirtualDesktopError["code"], message: string) {
  return new VirtualDesktopError({ code, message });
}
export function nativeHelperPath() {
  return fileURLToPath(
    new URL(
      import.meta.url.endsWith(".ts") ? "../../dist/cafe-desktop-native" : "./cafe-desktop-native",
      import.meta.url,
    ),
  ).replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
}
export const nativeHelperReady = (helper: string): Promise<boolean> =>
  new Promise((resolve) => {
    // Also catches missing ELF/shared-library dependencies in a packaged build.
    execFile(
      helper,
      ["--version"],
      { encoding: "utf8", timeout: 2500, maxBuffer: 1024, shell: false },
      (error, stdout) => resolve(!error && stdout.trim() === "cafe-desktop-native 1"),
    );
  });
export async function executable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (path.isAbsolute(name))
    return fs.access(name, fs.constants.X_OK).then(
      () => name,
      () => null,
    );
  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    const file = path.join(directory, name);
    try {
      await fs.access(file, fs.constants.X_OK);
      return file;
    } catch {
      /* next explicit PATH directory */
    }
  }
  return null;
}
export function nativeRequest(
  helper: string,
  bootstrap: string,
  request: unknown,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    // Each request has a disposable encoder child, never ownership of Sway.
    // Closing its socket cancels held input in the native worker.
    const child = spawn(helper, ["request", bootstrap], {
      stdio: ["pipe", "pipe", "ignore"],
      shell: false,
    });
    let size = 0;
    const chunks: Buffer[] = [];
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        desktopError(
          "operation_failed",
          "The desktop worker is unavailable; the action may have completed.",
        ),
      );
    };
    const method =
      typeof request === "object" && request !== null && "method" in request ? request.method : "";
    const timer = setTimeout(fail, method === "act" ? 45_000 : method === "observe" ? 5000 : 2500);
    const abort = () => fail();
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", fail);
    child.stdin.on("error", fail);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) fail();
      else chunks.push(chunk);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (settled) return;
      if (code !== 0) {
        fail();
        return;
      }
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
        settled = true;
        resolve(value as Record<string, unknown>);
      } catch {
        fail();
      }
    });
    if (signal?.aborted) fail();
    else child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

/** Structured i3 IPC framing avoids passing window selectors to a shell. */
export function swayRequest(
  socketPath: string,
  type: number,
  payload = "",
  signal?: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(desktopError("operation_failed", "Desktop request was cancelled."));
      return;
    }
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => socket.destroy(new Error("timeout")), 3000);
    const abort = () => socket.destroy(new Error("cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    const chunks: Buffer[] = [];
    let size = 0,
      expected: number | undefined;
    socket.on("error", () => {
      clearTimeout(timer);
      reject(desktopError("operation_failed", "Sway did not answer the desktop request."));
    });
    socket.on("connect", () => {
      const body = Buffer.from(payload);
      const header = Buffer.alloc(14);
      header.write("i3-ipc");
      header.writeUInt32LE(body.length, 6);
      header.writeUInt32LE(type, 10);
      socket.write(Buffer.concat([header, body]));
    });
    socket.on("data", (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        socket.destroy(new Error("oversized"));
        return;
      }
      chunks.push(chunk);
      const data = Buffer.concat(chunks);
      if (data.length >= 14 && expected === undefined) {
        if (
          data.subarray(0, 6).toString() !== "i3-ipc" ||
          data.readUInt32LE(10) !== type ||
          data.readUInt32LE(6) > 2 * 1024 * 1024 - 14
        ) {
          socket.destroy(new Error("invalid"));
          return;
        }
        expected = 14 + data.readUInt32LE(6);
      }
      if (expected !== undefined && data.length >= expected) {
        clearTimeout(timer);
        socket.destroy();
        try {
          resolve(JSON.parse(data.subarray(14, expected).toString("utf8")));
        } catch {
          reject(desktopError("operation_failed", "Sway returned an invalid response."));
        }
      }
    });
    socket.on("close", () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (expected === undefined || size < expected)
        reject(desktopError("operation_failed", "Sway disconnected."));
    });
  });
}
export async function processIdentity(pid: number): Promise<string | null> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch (error) {
    // /proc can disappear before open (ENOENT) or lose its task between open
    // and read (ESRCH). Both prove this incarnation is gone; permission/I/O
    // failures remain inconclusive and must never authorize a signal.
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw desktopError("operation_failed", "Desktop process ownership could not be verified.");
  }
}
