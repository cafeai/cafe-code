import { isIndeterminateTransportError } from "./transportError";

const DEFAULT_RETRY_DELAYS_MS = [
  250, 500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 30_000,
] as const;

interface IdempotentDispatchRetryOptions {
  /**
   * Tests can provide a short deterministic schedule. Production callers use
   * the bounded 90.75-second reconnect window above.
   */
  readonly retryDelaysMs?: ReadonlyArray<number>;
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly onRetry?: (input: {
    readonly attempt: number;
    readonly delayMs: number;
    readonly error: unknown;
  }) => void;
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

/**
 * Retries an orchestration command whose WebSocket acknowledgement was lost.
 *
 * The caller must close over the exact same command object, including its
 * commandId, for every attempt. The server commits orchestration events and the
 * command receipt in one SQLite transaction; replaying the same commandId reads
 * that receipt and cannot append a duplicate user message or provider steer.
 */
export async function dispatchIdempotentCommandWithTransportRetry<T>(
  dispatch: () => Promise<T>,
  options: IdempotentDispatchRetryOptions = {},
): Promise<T> {
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const wait = options.sleep ?? sleep;

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await dispatch();
    } catch (error) {
      const delayMs = retryDelaysMs[attempt];
      if (!isIndeterminateTransportError(error) || delayMs === undefined) {
        throw error;
      }

      options.onRetry?.({ attempt: attempt + 1, delayMs, error });
      await wait(delayMs);
    }
  }
}
