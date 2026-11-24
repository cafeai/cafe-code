// Exact status-only child transport; this process never controls applications.
// @effect-diagnostics nodeBuiltinImport:off
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { readGlideFrames, writeGlideFrame } from "./framing.ts";

/** The status-only child's environment omits provider credentials and user
 * Node/dynamic-loader hooks. It exposes no application observation or input. */
export function glideChildEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: "1" };
  for (const key of [
    "PATH",
    "HOME",
    "CFFIXED_USER_HOME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "SystemRoot",
    "WINDIR",
    "USERPROFILE",
  ]) {
    if (environment[key] !== undefined) result[key] = environment[key];
  }
  return result;
}

export class GlideChild {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<void>;
  private writes = Promise.resolve();
  private dead = false;
  private stopping: Promise<void> | undefined;

  constructor(
    command: string,
    args: string[],
    onMessage: (value: unknown) => void,
    onFailure: () => void,
  ) {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: glideChildEnvironment(process.env),
    });
    this.child = child;
    const fail = () => {
      if (!this.dead) {
        this.dead = true;
        onFailure();
      }
    };
    this.exited = new Promise((resolve) => {
      this.child.once("exit", fail);
      this.child.once("error", fail);
      // Exit can precede stdio retirement. Join actual native close before a
      // replacement is admitted, including failure before successful spawn.
      this.child.once("close", () => {
        fail();
        resolve();
      });
    });
    // Native/worker stderr never enters a provider log: it can contain OS paths.
    // Drain it so a full pipe cannot deadlock a process we are waiting to retire.
    this.child.stderr.resume();
    this.child.stdin.on("error", fail);
    void (async () => {
      try {
        for await (const message of readGlideFrames(child.stdout)) onMessage(message);
      } catch {
        fail();
      } finally {
        fail();
      }
    })();
  }

  send(message: unknown) {
    this.writes = this.writes.then(() => {
      if (this.dead) throw new Error("Glide subprocess is unavailable.");
      return writeGlideFrame(this.child.stdin, message);
    });
    return this.writes;
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      this.dead = true;
      this.child.stdin.destroy();
      // A graceful helper exit retires its status UI. Escalation acts only on this
      // exact, non-detached ChildProcess; there is no PID lookup or tree reaper.
      this.child.kill("SIGTERM");
      // Native callback deadline keeps exact socket/process lifetime, cancellation and ref/unref behavior.
      // @effect-diagnostics-next-line globalTimers:off
      const force = setTimeout(() => this.child.kill("SIGKILL"), 1500);
      try {
        await this.exited;
      } finally {
        clearTimeout(force);
        this.child.stdout.destroy();
        this.child.stderr.destroy();
      }
    })();
    return this.stopping;
  }
}

export async function validateGlideHelper(path: string): Promise<string> {
  if (process.platform !== "darwin" || !isAbsolute(path) || (await realpath(path)) !== path)
    throw new Error("Invalid status-only helper.");
  const metadata = await lstat(path, { bigint: true });
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    !(metadata.mode & BigInt(constants.S_IXUSR)) ||
    (metadata.mode & 0o022n) !== 0n ||
    (metadata.uid !== BigInt(process.getuid?.() ?? -1) && metadata.uid !== 0n)
  )
    throw new Error("Unsafe status-only helper.");
  return path;
}
