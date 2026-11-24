// Exact native MCP child boundary retains stdio lifetime and close ownership.
// @effect-diagnostics nodeBuiltinImport:off
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { GLIDE_FRAME_BYTES } from "./protocol.ts";

interface OpenAiMcpChildOptions {
  command: string;
  args?: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** The SDK stdio transport may return after sending SIGKILL. Cafe must join
 * actual native close before replacing this exact owner or deleting its home. */
export class OpenAiMcpChild implements Transport {
  onmessage?: NonNullable<Transport["onmessage"]>;
  onerror?: NonNullable<Transport["onerror"]>;
  onclose?: NonNullable<Transport["onclose"]>;
  private child: ChildProcessWithoutNullStreams | undefined;
  private closed: Promise<void> | undefined;
  private retiring: Promise<void> | undefined;
  private dead = false;
  private notified = false;
  private writes: Promise<void> = Promise.resolve();
  private readonly buffer = new ReadBuffer({ maxBufferSize: GLIDE_FRAME_BYTES });
  private readonly options: OpenAiMcpChildOptions;

  constructor(options: OpenAiMcpChildOptions) {
    this.options = options;
  }

  async start() {
    if (this.child || this.dead) throw new Error("Computer-use transport cannot start.");
    const child = spawn(this.options.command, [...(this.options.args ?? [])], {
      cwd: this.options.cwd,
      env: this.options.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.closed = new Promise<void>((resolve) => {
      child.once("close", () => {
        this.dead = true;
        this.notifyClosed();
        resolve();
      });
    });
    const fail = () => {
      if (this.dead) return;
      this.dead = true;
      this.onerror?.(new Error("OpenAI computer-use process became unavailable."));
      this.notifyClosed();
      void this.close();
    };
    child.once("error", fail);
    child.once("exit", fail);
    child.stdin.on("error", fail);
    child.stdout.on("error", fail);
    // Native stderr can contain paths, account diagnostics or application data.
    // Drain it without logging it, including during cancellation and shutdown.
    child.stderr.on("error", fail);
    child.stderr.resume();
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.dead) return;
      try {
        this.buffer.append(chunk);
        for (;;) {
          const message = this.buffer.readMessage();
          if (message === null) break;
          this.onmessage?.(message);
        }
      } catch {
        fail();
      }
    });
  }

  private notifyClosed() {
    if (this.notified) return;
    this.notified = true;
    this.onclose?.();
  }

  send(message: JSONRPCMessage): Promise<void> {
    const child = this.child;
    this.writes = this.writes.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (this.dead || !child) {
            reject(new Error("Computer-use transport is closed."));
            return;
          }
          const bytes = serializeMessage(message);
          if (Buffer.byteLength(bytes) > GLIDE_FRAME_BYTES) {
            reject(new Error("Computer-use request exceeded its limit."));
            return;
          }
          child.stdin.write(bytes, (error) => (error ? reject(error) : resolve()));
        }),
    );
    return this.writes;
  }

  close(): Promise<void> {
    if (this.retiring) return this.retiring;
    this.dead = true;
    this.notifyClosed();
    const child = this.child;
    this.retiring = (async () => {
      if (!child) return;
      child.stdin.end();
      // These deadlines escalate only this retained, unreaped native child.
      // @effect-diagnostics-next-line globalTimers:off
      const term = setTimeout(() => child.kill("SIGTERM"), 1500);
      // @effect-diagnostics-next-line globalTimers:off
      const kill = setTimeout(() => child.kill("SIGKILL"), 3000);
      try {
        await this.closed;
      } finally {
        clearTimeout(term);
        clearTimeout(kill);
        child.stdout.destroy();
        child.stderr.destroy();
        this.buffer.clear();
      }
    })();
    return this.retiring;
  }
}
