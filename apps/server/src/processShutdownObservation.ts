import * as Effect from "effect/Effect";

/**
 * Process-wide observation that this Cafe process has been asked to stop.
 *
 * The desktop stops the detached provider daemon through its child handle,
 * which signals the daemon's whole process group. Provider children (Codex
 * app-server, Claude Code) therefore receive SIGTERM at the same moment as
 * the daemon and can exit (Codex with 0, Claude Code with 143) before the
 * daemon's session scopes have marked those runtimes closed. Every open chat
 * then received a false "exited unexpectedly" provider error after a restart.
 *
 * This flag is presentation/lifecycle classification only: it lets exit
 * observers describe such an exit as a stop instead of a provider failure.
 * It never grants permission to kill, replay, resume or skip persistence, and
 * it is never reset within a process: once shutdown is requested, the
 * process is ending.
 *
 * Install only from the real CLI entrypoint, next to `NodeRuntime.runMain`,
 * which owns the actual termination behavior. Adding a SIGTERM listener in a
 * process without that runtime would replace Node's default exit-on-signal.
 */
let shutdownRequestedAtMs: number | null = null;
let installed = false;
const waiters = new Set<() => void>();

const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

export function installProcessShutdownObservation(): void {
  if (installed) return;
  installed = true;
  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, markProcessShutdownRequested);
  }
}

export function markProcessShutdownRequested(): void {
  if (shutdownRequestedAtMs !== null) return;
  shutdownRequestedAtMs = Date.now();
  // Each waiter removes only itself; Set iteration tolerates that deletion.
  for (const waiter of waiters) waiter();
}

export function isProcessShutdownRequested(): boolean {
  return shutdownRequestedAtMs !== null;
}

/**
 * A child usually observes the same signal a few milliseconds before or after
 * its owner. Exit observers wait at most this long for the owner's own signal
 * before classifying an exit as a provider failure.
 */
export const PROCESS_SHUTDOWN_EXIT_GRACE_MS = 750;

/**
 * Resolves `true` as soon as shutdown is requested, or with the final answer
 * once the grace window ends. The window is a real wall-clock race between
 * two OS signal deliveries, so it deliberately uses a native timer rather
 * than the Effect `Clock` (which tests replace with a virtual clock that
 * would otherwise freeze crash classification). Interruption clears it.
 */
export const awaitProcessShutdownEvidence: Effect.Effect<boolean> = Effect.callback<boolean>(
  (resume) => {
    if (shutdownRequestedAtMs !== null) {
      resume(Effect.succeed(true));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      if (timer !== undefined) clearTimeout(timer);
      waiters.delete(settle);
      resume(Effect.succeed(shutdownRequestedAtMs !== null));
    };
    waiters.add(settle);
    timer = setTimeout(settle, PROCESS_SHUTDOWN_EXIT_GRACE_MS);
    return Effect.sync(() => {
      if (timer !== undefined) clearTimeout(timer);
      waiters.delete(settle);
    });
  },
);

/** Test seam only: production processes never clear an observed shutdown. */
export function resetProcessShutdownObservationForTests(): void {
  shutdownRequestedAtMs = null;
}
