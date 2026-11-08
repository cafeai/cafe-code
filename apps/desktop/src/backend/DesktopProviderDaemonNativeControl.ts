// This boundary owns only its retained bundled helper child and private pipes.
// The helper alone holds the kernel audit token; no token/PID signal is exposed.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { spawn } from "node:child_process";
// Exact bundled executable identity, not a PATH search or provider installation.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { lstat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { DesktopEnvironment } from "../app/DesktopEnvironment.ts";

export interface DesktopProviderDaemonNativeController {
  readonly forceStop: Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
}

export interface ProviderDaemonNativeCaptureInput {
  readonly pid: number;
  readonly createdAt: string;
  readonly expectedExecutable?: string;
}

export class DesktopProviderDaemonNativeControl extends Context.Service<
  DesktopProviderDaemonNativeControl,
  {
    readonly capture: (
      input: ProviderDaemonNativeCaptureInput,
    ) => Effect.Effect<
      DesktopProviderDaemonNativeController | undefined,
      ProviderDaemonNativeControlError
    >;
  }
>()("cafecode/desktop/ProviderDaemonNativeControl") {}

/** Fixed phase only: no native body, executable path or kernel identity leaks. */
export class ProviderDaemonNativeControlError extends Error {
  constructor(readonly phase: "native-control" | "native-identity" | "native-exit") {
    super(
      "The selected provider daemon could not be safely stopped. Its recovery files were preserved.",
    );
  }
}

const refusalReasons = new Set([
  "input-invalid",
  "unsupported",
  "identity-mismatch",
  "owner-unknown",
  "signal-refused",
  "exit-unconfirmed",
  "cancelled",
]);

/** Capture performs no target control. Ready means the helper retained the
 * exact same-user executable/birth/audit-token owner across the modal await.
 * The resulting live controller must be closed by its manager, not by the
 * short capture fiber's scope. Only explicit forceStop writes opcode one. */
export async function captureMacProviderDaemonNativeControl(
  candidates: readonly string[],
  input: ProviderDaemonNativeCaptureInput,
  signal: AbortSignal,
): Promise<DesktopProviderDaemonNativeController | undefined> {
  const executableBytes = Buffer.from(input.expectedExecutable ?? process.execPath, "utf8");
  const milliseconds = Date.parse(input.createdAt);
  if (
    !Number.isSafeInteger(input.pid) ||
    input.pid <= 0 ||
    input.pid > 2_147_483_647 ||
    !Number.isSafeInteger(milliseconds) ||
    milliseconds <= 0 ||
    new Date(milliseconds).toISOString() !== input.createdAt ||
    executableBytes.length === 0 ||
    executableBytes.length > 4096 ||
    executableBytes.includes(0)
  )
    return undefined;
  signal.throwIfAborted();
  let executable: string | undefined;
  let identity: Awaited<ReturnType<typeof lstat>> | undefined;
  for (const candidate of candidates) {
    try {
      const stat = await lstat(candidate);
      if (
        stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.nlink === 1 &&
        (stat.mode & 0o111) !== 0 &&
        (stat.mode & 0o022) === 0 &&
        (stat.uid === process.getuid?.() || stat.uid === 0)
      ) {
        executable = candidate;
        identity = stat;
        break;
      }
    } catch {
      /* Only fixed bundled candidates; no PATH or download fallback. */
    }
    signal.throwIfAborted();
  }
  if (executable === undefined || identity === undefined) return undefined;
  signal.throwIfAborted();
  const nonce = randomBytes(16),
    nonceHex = nonce.toString("hex");
  const header = Buffer.alloc(24);
  header.write("CAFEFD01", 0, "ascii");
  header.writeUInt32BE(input.pid, 8);
  header.writeBigUInt64BE(BigInt(milliseconds) * 1000n, 12);
  header.writeUInt32BE(executableBytes.length, 20);
  const child = spawn(executable, [], {
    shell: false,
    detached: false,
    // Native ownership observation needs no user configuration or loader hooks.
    // In particular, inherited DYLD/LD preloads cannot alter the kernel bridge.
    env: { LANG: "C", LC_ALL: "C" },
    stdio: ["pipe", "pipe", "ignore"],
  });
  let closing = false,
    closed = false,
    ready = false,
    forceSent = false,
    forceCommandWritten = false,
    stopped = false;
  let failurePhase: "native-control" | "native-identity" | "native-exit" = "native-control";
  let failed = false,
    totalBytes = 0,
    frameCount = 0,
    buffer = "";
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  let forceIssuedAtMs: number | undefined;
  let resolveReady!: () => void, rejectReady!: (error: ProviderDaemonNativeControlError) => void;
  const admitted = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Native spawn/pipe failure can precede the executable identity recheck.
  // Keep that rejection observed until the same owner reaches its await.
  void admitted.catch(() => undefined);
  let resolveForce!: () => void, rejectForce!: (error: ProviderDaemonNativeControlError) => void;
  const forced = new Promise<void>((resolve, reject) => {
    resolveForce = resolve;
    rejectForce = reject;
  });
  // A refused/closed capture never leaves an unobserved rejected force Promise.
  void forced.catch(() => undefined);
  let resolveClose!: () => void;
  const nativeClose = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });
  const close = () => {
    if (!closing) {
      closing = true;
      clearTimeout(readyTimer);
      // Before consent EOF is cancellation. Once the one force command was
      // sent, keep its pipe alive through the helper's bounded terminal result;
      // cancellation must not HUP it halfway through the native stop sequence.
      if (!forceCommandWritten) child.stdin.end();
      if (!closed) {
        // Only the retained helper child is retired here. Its target capability
        // is never converted into a Node process.kill or a process-tree signal.
        // @effect-diagnostics-next-line globalTimers:off
        closeTimer = setTimeout(
          () => {
            if (!closed) child.kill("SIGKILL");
          },
          forceCommandWritten
            ? Math.max(0, 8_000 - (Date.now() - (forceIssuedAtMs ?? Date.now())))
            : 2_000,
        );
      }
    }
    return nativeClose;
  };
  const fail = (phase: "capture" | "protocol" | "force" | "close") => {
    failed = true;
    failurePhase = phase === "force" || phase === "close" ? "native-exit" : "native-control";
    const error = new ProviderDaemonNativeControlError(failurePhase);
    rejectReady(error);
    rejectForce(error);
    void close();
  };
  const onCaptureAbort = () => {
    fail("capture");
  };
  signal.addEventListener("abort", onCaptureAbort, { once: true });
  child.stdin.on("error", () => fail(forceSent ? "force" : "capture"));
  child.stdout.on("error", () => fail(forceSent ? "force" : "capture"));
  child.on("error", () => fail("capture"));
  child.once("close", (code, nativeSignal) => {
    closed = true;
    clearTimeout(readyTimer);
    clearTimeout(closeTimer);
    clearTimeout(forceTimer);
    if (buffer.length !== 0) {
      failed = true;
      failurePhase = "native-control";
    }
    signal.removeEventListener("abort", onCaptureAbort);
    if (!ready) rejectReady(new ProviderDaemonNativeControlError("native-control"));
    if (forceSent && stopped && !failed && code === 0 && nativeSignal === null) resolveForce();
    else rejectForce(new ProviderDaemonNativeControlError("native-exit"));
    resolveClose();
  });
  child.stdout.on("data", (chunk: Buffer) => {
    if (closed) return;
    totalBytes += chunk.length;
    if (totalBytes > 4096) {
      fail("protocol");
      return;
    }
    buffer += chunk.toString("utf8");
    if (buffer.length > 1024 && !buffer.includes("\n")) {
      fail("protocol");
      return;
    }
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n"),
        line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.length > 1024 || ++frameCount > 2) {
        fail("protocol");
        return;
      }
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(line);
      } catch {
        fail("protocol");
        return;
      }
      if (
        typeof frame !== "object" ||
        frame === null ||
        Array.isArray(frame) ||
        frame.version !== 1 ||
        frame.nonce !== nonceHex
      ) {
        fail("protocol");
        return;
      }
      const keys = Object.keys(frame).sort().join(",");
      if (
        frame.phase === "ready" &&
        keys === "nonce,phase,version" &&
        !ready &&
        !forceSent &&
        !closing
      ) {
        ready = true;
        clearTimeout(readyTimer);
        resolveReady();
      } else if (
        frame.phase === "stopped" &&
        keys === "nonce,phase,version" &&
        ready &&
        forceSent &&
        !stopped &&
        !closing
      ) {
        stopped = true;
        // A stopped JSON frame alone is not completion; join actual helper close.
      } else if (
        frame.phase === "refused" &&
        keys === "nonce,phase,reason,version" &&
        refusalReasons.has(frame.reason as string)
      ) {
        failurePhase =
          frame.reason === "identity-mismatch" || frame.reason === "owner-unknown"
            ? "native-identity"
            : forceSent
              ? "native-exit"
              : "native-control";
        failed = true;
        rejectReady(new ProviderDaemonNativeControlError(failurePhase));
        rejectForce(new ProviderDaemonNativeControlError(failurePhase));
        void close();
        return;
      } else {
        fail("protocol");
        return;
      }
    }
  });
  // @effect-diagnostics-next-line globalTimers:off
  readyTimer = setTimeout(() => fail("capture"), 5_000);
  child.stdin.write(Buffer.concat([header, executableBytes, nonce]), (error) => {
    if (error) fail("capture");
  });
  try {
    const after = await lstat(executable);
    for (const field of [
      "dev",
      "ino",
      "uid",
      "gid",
      "mode",
      "nlink",
      "size",
      "mtimeMs",
      "ctimeMs",
    ] as const)
      if (after[field] !== identity[field])
        throw new ProviderDaemonNativeControlError("native-control");
    await admitted;
    signal.throwIfAborted();
    if (closed || closing || failed) throw new ProviderDaemonNativeControlError(failurePhase);
    // The manager now owns the helper across the human await. Ending this
    // short capture Effect must not cancel its still-unforced native lease.
    return {
      forceStop: Effect.tryPromise({
        try: async (forceSignal) => {
          if (closed || closing || failed || !ready || forceSent)
            throw new ProviderDaemonNativeControlError("native-exit");
          forceSent = true;
          forceIssuedAtMs = Date.now();
          const onAbort = () => {
            void close();
          };
          forceSignal.addEventListener("abort", onAbort, { once: true });
          try {
            forceSignal.throwIfAborted();
            forceCommandWritten = true;
            child.stdin.write(Buffer.concat([Buffer.from([1]), nonce]), (error) => {
              if (error) fail("force");
            });
            // Native TERM/KILL budgets total five seconds. This extra envelope
            // bounds transport/close uncertainty without extending native control.
            // @effect-diagnostics-next-line globalTimers:off
            forceTimer = setTimeout(() => fail("force"), 8_000);
            await forced;
          } finally {
            forceSignal.removeEventListener("abort", onAbort);
          }
        },
        catch: () => new ProviderDaemonNativeControlError("native-exit"),
      }).pipe(
        Effect.orDie,
        Effect.ensuring(
          Effect.promise(async () => {
            if (!closed) await close();
          }),
        ),
      ),
      close: Effect.promise(close),
    };
  } catch {
    signal.removeEventListener("abort", onCaptureAbort);
    await close();
    throw new ProviderDaemonNativeControlError(failurePhase);
  }
}

export const layer = Layer.effect(
  DesktopProviderDaemonNativeControl,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment;
    if (environment.platform !== "darwin") return { capture: () => Effect.succeed(undefined) };
    const candidates = [
      ...environment.resolveResourcePathCandidates("mac-provider-daemon-control"),
      ...(!environment.isPackaged
        ? [
            environment.path.join(
              environment.rootDir,
              "apps/desktop/native/build",
              environment.processArch,
              "mac-provider-daemon-control",
            ),
          ]
        : []),
    ];
    const owners = new Set<DesktopProviderDaemonNativeController>();
    yield* Effect.addFinalizer(() =>
      Effect.forEach([...owners], (owner) => owner.close, { concurrency: 1 }).pipe(Effect.asVoid),
    );
    return {
      capture: (input: ProviderDaemonNativeCaptureInput) =>
        Effect.tryPromise({
          try: (signal) => captureMacProviderDaemonNativeControl(candidates, input, signal),
          catch: (cause) =>
            cause instanceof ProviderDaemonNativeControlError
              ? cause
              : new ProviderDaemonNativeControlError("native-control"),
        }).pipe(
          Effect.map((owner) => {
            if (owner === undefined) return undefined;
            const wrapped: DesktopProviderDaemonNativeController = {
              forceStop: owner.forceStop,
              close: owner.close.pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    owners.delete(wrapped);
                  }),
                ),
              ),
            };
            owners.add(wrapped);
            return wrapped;
          }),
        ),
    };
  }),
);
