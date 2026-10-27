// Private native helper keeps exact stdio/child ownership and bounded retirement.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
// Private native filesystem boundary retains no-follow descriptors and bigint namespace identity.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { constants } from "node:fs";
// Private native filesystem boundary retains no-follow descriptors and bigint namespace identity.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { lstat, realpath } from "node:fs/promises";
// Native namespace boundary retains host drive, separator and canonical path semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { readGlideFrames, writeGlideFrame } from "./framing.ts";
import { makeGlideNativePhaseReader } from "./nativeDiagnostics.ts";
import {
  appListSchema,
  actionReceiptSchema,
  installedAppSchema,
  isGlideAction,
  unknownActionReceipt,
  glideRequestSchema,
  GLIDE_TIMEOUT_MS,
  jsInputSchema,
  glideInputModeSchema,
  type GlideInputMode,
  observationSchema,
  windowListSchema,
  type CellResult,
  type GlideRequest,
  type GlideActionReceipt,
} from "./protocol.ts";

const output = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }).strict(),
  z
    .object({ type: z.literal("image"), mimeType: z.literal("image/png"), data: z.string() })
    .strict(),
]);
const resultMessage = z
  .object({
    type: z.literal("result"),
    executionId: z.string(),
    result: z
      .object({ content: z.array(output).max(129), isError: z.boolean().optional() })
      .strict(),
  })
  .strict();
const rpcMessage = z
  .object({
    type: z.literal("rpc"),
    executionId: z.string(),
    id: z.number().int().positive(),
    request: glideRequestSchema,
  })
  .strict();
const nativeReply = z
  .object({
    id: z.number().int().positive(),
    result: z.unknown().optional(),
    error: z.string().max(2048).optional(),
  })
  .strict();

export class GlideExecutionError extends Error {
  readonly receipts: readonly GlideActionReceipt[];
  constructor(message: string, receipts: readonly GlideActionReceipt[]) {
    super(message);
    this.name = "GlideExecutionError";
    this.receipts = receipts;
  }
}

export function glideExecutionFailure(error: unknown): CellResult {
  return {
    isError: true,
    content: [
      ...(error instanceof GlideExecutionError
        ? error.receipts.map((receipt) => ({
            type: "text" as const,
            text: `Glide action ${JSON.stringify(receipt)}`,
          }))
        : []),
      {
        type: "text",
        text: error instanceof Error ? error.message.slice(0, 2048) : "Glide execution failed.",
      },
    ],
  };
}

/** Child environments intentionally omit provider credentials and user Node /
 * dynamic-loader hooks. The kernel is trusted code execution, not a VM sandbox. */
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
    onNativePhase?: (phase: string) => void,
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
    if (onNativePhase) {
      this.child.stderr.on("data", makeGlideNativePhaseReader(onNativePhase));
    }
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
      // A graceful helper exit releases held input. Escalation acts only on this
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
  if (process.platform !== "darwin")
    throw new Error("The native Glide backend currently requires macOS.");
  if (!isAbsolute(path) || (await realpath(path)) !== path)
    throw new Error("Glide helper must be an absolute path without symlink components.");
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    !(metadata.mode & constants.S_IXUSR) ||
    (metadata.mode & 0o022) !== 0 ||
    (metadata.uid !== process.getuid?.() && metadata.uid !== 0)
  )
    throw new Error("Glide helper is not an admitted executable.");
  return path;
}

/** Trusted Cafe host bridge. Session/cell identities are created by the broker,
 * never accepted from model JavaScript or its native RPC input. */
export interface GlideNativeBridge {
  invoke(request: GlideRequest, owner: { deadline: number; executionId: string }): Promise<unknown>;
  retire(executionId?: string): Promise<void>;
}

export class GlideRuntime {
  private readonly options: {
    helperPath: string;
    allowedApps: readonly string[];
    inputMode: GlideInputMode;
    workerPath?: string;
    nativePrefixArgs?: readonly string[];
    onNativePhase?: (phase: string) => void;
    nativeBridge?: GlideNativeBridge;
  };
  private worker: GlideChild | undefined;
  private native: GlideChild | undefined;
  private generation = 0;
  private sequence = 0;
  private nativeSequence = 0;
  private closed = false;
  private queued = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private nativeTail: Promise<unknown> = Promise.resolve();
  private nativePending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private current:
    | {
        id: string;
        deadline: number;
        resolve: (value: CellResult) => void;
        reject: (error: Error) => void;
        rpcIds: Set<number>;
        receipts: GlideActionReceipt[];
        actions: Map<number, { method: string; entered: boolean }>;
      }
    | undefined;
  private retirement: Promise<void> = Promise.resolve();

  constructor(options: {
    helperPath: string;
    allowedApps: readonly string[];
    inputMode?: GlideInputMode;
    workerPath?: string;
    nativePrefixArgs?: readonly string[];
    onNativePhase?: (phase: string) => void;
    nativeBridge?: GlideNativeBridge;
  }) {
    this.options = {
      ...options,
      allowedApps: [...options.allowedApps],
      inputMode: glideInputModeSchema.parse(options.inputMode),
    };
    if (
      (!options.allowedApps.length && !options.nativeBridge) ||
      options.allowedApps.length > 16 ||
      options.allowedApps.some((app) => !/^[A-Za-z0-9][A-Za-z0-9.-]{1,254}$/.test(app))
    )
      throw new Error("Specify between one and sixteen allowed application bundle IDs.");
  }

  private retire(message: string): Promise<void> {
    this.generation++;
    const retiringExecution = this.current?.id;
    const worker = this.worker,
      native = this.native;
    this.worker = undefined;
    this.native = undefined;
    this.current?.reject(this.executionError(message));
    this.current = undefined;
    for (const pending of this.nativePending.values()) pending.reject(new Error(message));
    this.nativePending.clear();
    this.retirement = Promise.all([
      this.retirement,
      worker?.stop(),
      native?.stop(),
      this.options.nativeBridge?.retire(retiringExecution),
    ]).then(() => undefined);
    void this.retirement.catch(() => undefined);
    return this.retirement;
  }

  private executionError(message: string) {
    const receipts = [...(this.current?.receipts ?? [])];
    for (const [id, action] of this.current?.actions ?? []) {
      const receipt = unknownActionReceipt(
        action.method,
        `${this.current!.id}:${id}`,
        "Execution retired before an action response. Inspect fresh state; do not replay it automatically.",
      );
      if (!action.entered) {
        receipt.dispatch = "not-dispatched";
        receipt.status = "refused";
        receipt.stage = "queued";
      }
      receipts.push(receipt);
    }
    return new GlideExecutionError(message, receipts.slice(-64));
  }

  private ensureProcesses() {
    const generation = this.generation;
    const fail = () => {
      if (this.generation !== generation) return;
      void this.retire(
        "Glide subprocess stopped. The execution was reset; inspect app state before repeating an action.",
      );
    };
    if (!this.native && !this.options.nativeBridge) {
      this.native = new GlideChild(
        this.options.helperPath,
        [
          ...(this.options.nativePrefixArgs ?? []),
          "--input-mode",
          this.options.inputMode,
          ...this.options.allowedApps.flatMap((app) => ["--allow-app", app]),
        ],
        (value) => {
          const reply = nativeReply.parse(value);
          const pending = this.nativePending.get(reply.id);
          if (!pending) throw new Error("Unknown native Glide reply.");
          this.nativePending.delete(reply.id);
          if (reply.error !== undefined) pending.reject(new Error(reply.error));
          else pending.resolve(reply.result);
        },
        fail,
        this.options.onNativePhase,
      );
    }
    if (!this.worker) {
      const workerPath =
        this.options.workerPath ??
        fileURLToPath(
          new URL(
            import.meta.url.endsWith(".ts") ? "./worker.ts" : "./glide-worker.mjs",
            import.meta.url,
          ),
        );
      this.worker = new GlideChild(
        process.execPath,
        ["--experimental-vm-modules", "--max-old-space-size=256", workerPath],
        (value) => {
          const result = resultMessage.safeParse(value);
          if (result.success) {
            if (result.data.executionId !== this.current?.id || this.nativePending.size)
              throw new Error("Glide result has no matching execution.");
            this.current.resolve({
              content: result.data.result.content,
              ...(result.data.result.isError === undefined
                ? {}
                : { isError: result.data.result.isError }),
            });
            this.current = undefined;
            return;
          }
          const rpc = rpcMessage.parse(value);
          const active = this.current;
          if (
            !active ||
            rpc.executionId !== active.id ||
            active.rpcIds.has(rpc.id) ||
            active.rpcIds.size >= 256
          )
            throw new Error("Glide RPC has no matching execution or exceeded its operation limit.");
          active.rpcIds.add(rpc.id);
          if (isGlideAction(rpc.request.method))
            active.actions.set(rpc.id, { method: rpc.request.method, entered: false });
          const sourceWorker = this.worker;
          // The helper is serial even when a model submits Promise.all. Every
          // queued operation rechecks exact execution ownership before dispatch.
          const operation = this.nativeTail.then(async () => {
            if (this.current !== active) throw new Error("Glide execution expired.");
            const action = active.actions.get(rpc.id);
            if (action) action.entered = true;
            const result = await this.invokeNative(rpc.request, active.deadline);
            if (rpc.request.method === "get_app_state") {
              const observed = observationSchema.parse(result);
              // The tray's private thumbnail never enters the model worker or
              // tool/journal output, including standalone native connections.
              delete observed.screenshotPreview;
              return observed;
            }
            if (rpc.request.method === "list_apps") return appListSchema.parse(result);
            if (rpc.request.method === "list_windows") return windowListSchema.parse(result);
            if (rpc.request.method === "resolve_app") return installedAppSchema.parse(result);
            const receipt =
              result === null
                ? {
                    ...unknownActionReceipt(
                      rpc.request.method,
                      `${active.id}:${rpc.id}`,
                      "Legacy helper returned no action evidence.",
                    ),
                    status: "unverified" as const,
                  }
                : actionReceiptSchema.parse(result);
            if (receipt.method !== rpc.request.method)
              throw new Error("Native action receipt method mismatch.");
            active.actions.delete(rpc.id);
            active.receipts.push(receipt);
            if (active.receipts.length > 64) active.receipts.shift();
            return receipt;
          });
          this.nativeTail = operation.catch(() => undefined);
          void operation
            .then(
              (result) => ({ type: "rpc-result", executionId: active.id, id: rpc.id, result }),
              (error: unknown) => {
                const message =
                  error instanceof Error ? error.message.slice(0, 2048) : "Glide operation failed.";
                if (isGlideAction(rpc.request.method)) {
                  const receipt = unknownActionReceipt(
                    rpc.request.method,
                    `${active.id}:${rpc.id}`,
                    message,
                  );
                  if (!active.actions.get(rpc.id)?.entered) {
                    receipt.dispatch = "not-dispatched";
                    receipt.status = "refused";
                    receipt.stage = "queued";
                  }
                  active.actions.delete(rpc.id);
                  active.receipts.push(receipt);
                  if (active.receipts.length > 64) active.receipts.shift();
                  return {
                    type: "rpc-result",
                    executionId: active.id,
                    id: rpc.id,
                    result: receipt,
                  };
                }
                return { type: "rpc-result", executionId: active.id, id: rpc.id, error: message };
              },
            )
            .then(async (reply) => {
              if (this.current === active && this.worker === sourceWorker)
                await sourceWorker?.send(reply);
            })
            .catch(fail);
        },
        fail,
      );
    }
  }

  private async invokeNative(request: GlideRequest, deadline: number): Promise<unknown> {
    if (this.options.nativeBridge) {
      const executionId = this.current?.id;
      if (!executionId || deadline <= performance.now())
        throw new Error("Glide execution expired.");
      return this.options.nativeBridge.invoke(request, { deadline, executionId });
    }
    const timeout_ms = Math.floor(deadline - performance.now());
    if (timeout_ms <= 0 || !this.native) throw new Error("Glide execution expired.");
    const id = ++this.nativeSequence;
    const result = new Promise<unknown>((resolve, reject) =>
      this.nativePending.set(id, { resolve, reject }),
    );
    // Attach rejection ownership before the first write can fail or reset can
    // reject the pending request. Never leave a rejected deferred unobserved.
    void result.catch(() => undefined);
    try {
      await this.native.send({
        id,
        ...request,
        timeout_ms,
        ...(request.method === "get_app_state" ? { visibilityVersion: 1 } : {}),
        ...(isGlideAction(request.method) ? { receiptVersion: 1 } : {}),
      });
    } catch {
      this.nativePending.delete(id);
      throw new Error("Native Glide connection was lost.");
    }
    return result;
  }

  async execute(input: z.infer<typeof jsInputSchema>, signal?: AbortSignal): Promise<CellResult> {
    const parsed = jsInputSchema.parse(input);
    if (this.closed || this.queued >= 4)
      throw new Error("Glide runtime is closed or its queue is full.");
    const generation = this.generation;
    const deadline = performance.now() + (parsed.timeout_ms ?? GLIDE_TIMEOUT_MS);
    const id = String(generation) + ":" + String(++this.sequence);
    let expired = false;
    let rejectExpiry!: (error: Error) => void;
    const expiry = new Promise<never>((_resolve, reject) => {
      rejectExpiry = reject;
    });
    const expire = (message: string) => {
      expired = true;
      const error =
        this.current?.id === id
          ? this.executionError(message)
          : new GlideExecutionError(message, []);
      if (this.current?.id === id) void this.retire(message);
      rejectExpiry(error);
    };
    const abort = () =>
      expire("Glide execution cancelled. Already-dispatched events may have taken effect.");
    // Queue time is part of the same nonrenewable deadline. Expiring a queued
    // cell never interrupts a different cell which currently owns the kernel.
    // Native callback deadline keeps exact socket/process lifetime, cancellation and ref/unref behavior.
    // @effect-diagnostics-next-line globalTimers:off
    const timer = setTimeout(
      () => expire("Glide execution timed out. Inspect app state before repeating an action."),
      Math.max(1, deadline - performance.now()),
    );
    signal?.addEventListener("abort", abort, { once: true });
    this.queued++;
    const operation = this.tail.then(async () => {
      await this.retirement;
      if (expired || this.closed || signal?.aborted || this.generation !== generation)
        throw new Error("Glide execution was cancelled or reset.");
      if (deadline <= performance.now()) throw new Error("Glide execution expired while queued.");
      this.ensureProcesses();
      const result = new Promise<CellResult>((resolve, reject) => {
        this.current = {
          id,
          deadline,
          resolve,
          reject,
          rpcIds: new Set(),
          receipts: [],
          actions: new Map(),
        };
      });
      void result.catch(() => undefined);
      try {
        if (signal?.aborted) abort();
        else await this.worker?.send({ type: "execute", executionId: id, code: parsed.code });
        return await result;
      } catch (error) {
        if (this.generation === generation)
          await this.retire("Glide execution stopped and was reset.");
        throw error;
      }
    });
    this.tail = operation
      .catch(() => undefined)
      .finally(() => {
        this.queued--;
      });
    try {
      if (signal?.aborted) abort();
      return await Promise.race([operation, expiry]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  reset() {
    return this.retire("Glide kernel reset. Earlier application edits remain.");
  }
  async close() {
    if (!this.closed) {
      this.closed = true;
      await this.reset();
    } else await this.retirement;
    await this.tail;
  }
}
