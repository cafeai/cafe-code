import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
type Fields = Record<string, unknown>;
export async function fieldFixture() {
  const profile = await mkdtemp(join(tmpdir(), "cafe-cua-input-"));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const child = spawn(
    require("electron") as string,
    [fileURLToPath(new URL("./electron-field.cjs", import.meta.url)), profile],
    { env, shell: false, stdio: ["pipe", "pipe", "pipe"] },
  );
  const lines = createInterface({ input: child.stdout });
  const replies = new Map<number, (value: Fields) => void>();
  let nextId = 0;
  let ready: (value: Fields) => void;
  const readiness = new Promise<Fields>((resolve, reject) => {
    ready = resolve;
    child.once("error", reject);
    child.once("exit", () =>
      reject(new Error("The owned Electron fixture exited before readiness.")),
    );
  });
  lines.on("line", (line) => {
    const value = JSON.parse(line) as Fields;
    if (value.ready) ready(value);
    else replies.get(Number(value.id))?.(value);
  });
  // Consume logs without treating Chromium diagnostics as protocol replies.
  child.stderr.resume();
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const close = async () => {
    child.stdin.end();
    const deadline = setTimeout(() => child.kill("SIGTERM"), 5000);
    try {
      await exited;
    } finally {
      clearTimeout(deadline);
      lines.close();
      await rm(profile, { recursive: true, force: true });
    }
  };
  try {
    const deadline = setTimeout(() => child.kill("SIGTERM"), 20_000);
    let info: Fields;
    try {
      info = await readiness;
    } finally {
      clearTimeout(deadline);
    }
    return {
      pid: Number(info.pid),
      windowId: Number(info.windowId),
      scene: (operation: "resize" | "occlude" | "unocclude" | "fullscreen" | "exit-fullscreen") =>
        new Promise<Fields>((resolve, reject) => {
          const id = ++nextId;
          const timeout = setTimeout(() => {
            replies.delete(id);
            reject(new Error("Owned fixture scene timed out"));
          }, 8000);
          replies.set(id, (value) => {
            clearTimeout(timeout);
            replies.delete(id);
            resolve(value);
          });
          child.stdin.write(JSON.stringify({ id, operation }) + "\n");
        }),
      reveal: () =>
        new Promise<void>((resolve, reject) => {
          const id = ++nextId;
          const timeout = setTimeout(() => {
            replies.delete(id);
            reject(new Error("Owned fixture reveal timed out"));
          }, 5000);
          replies.set(id, () => {
            clearTimeout(timeout);
            replies.delete(id);
            resolve();
          });
          child.stdin.write(JSON.stringify({ id, operation: "reveal" }) + "\n");
        }),
      state: () =>
        new Promise<Fields>((resolve, reject) => {
          const id = ++nextId;
          const timeout = setTimeout(() => {
            replies.delete(id);
            reject(new Error("The Electron input-state reply timed out."));
          }, 5000);
          replies.set(id, (value) => {
            clearTimeout(timeout);
            replies.delete(id);
            resolve(value);
          });
          child.stdin.write(JSON.stringify({ id, operation: "state" }) + "\n");
        }),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
