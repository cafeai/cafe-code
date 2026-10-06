import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import { CODEX_HISTORY_RECOVERY_REQUIRED_MESSAGE } from "@cafecode/shared/codexHistorySafety";

/** A diagnostic budget, not a limit on provider messages or model output. */
const MAX_HISTORY_ERROR_JSON_CHARS = 16_384;
export const CODEX_HISTORY_CANDIDATE_LIMIT = 32;
export const CODEX_HISTORY_CANDIDATE_ID_LIMIT = 1_024;
export const CODEX_HISTORY_DIAGNOSIS_UNCERTAIN_MESSAGE =
  "Codex accepted this request, but Cafe could not verify a saved-context diagnostic after conflicting turn events. Further submissions in this runtime are blocked. Do not resend automatically; inspect the provider state or continue in a new chat. No history was changed.";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Codex 0.160.1 forwards this upstream API error as JSON in TurnError.message.
 * Match the structured type, code, and exact input arguments field together.
 * Generic HTTP 400s, user prose, tool output and other oversized fields are not
 * evidence of invalid provider-owned history. Never retain the parsed body.
 * https://learn.chatgpt.com/docs/app-server#errors
 */
export function isCodexOversizedHistoryArgumentsError(message: unknown): boolean {
  if (typeof message !== "string" || message.length > MAX_HISTORY_ERROR_JSON_CHARS) return false;
  try {
    const error = record(record(JSON.parse(message))?.error);
    return (
      error?.type === "invalid_request_error" &&
      error.code === "string_above_max_length" &&
      typeof error.param === "string" &&
      /^input\[[0-9]{1,10}\]\.arguments$/.test(error.param)
    );
  } catch {
    return false;
  }
}

export interface CodexHistorySafetyCallbacks<E> {
  readonly isBlocked: (nativeThreadId: string) => Effect.Effect<boolean, E>;
  readonly markBlocked: (nativeThreadId: string) => Effect.Effect<void, E>;
}

/**
 * The local fence is installed before durable I/O. Thus a slow or failed
 * database write cannot admit another paid request in this runtime. Durable
 * callback failures remain failures; callers must not reinterpret uncertainty
 * as permission. There is deliberately no automatic clear/reset operation.
 */
export const makeCodexHistorySafety = <E>(callbacks?: CodexHistorySafetyCallbacks<E>) =>
  Effect.gen(function* () {
    const blocked = yield* Ref.make<ReadonlySet<string>>(new Set());
    const persisted = yield* Ref.make<ReadonlySet<string>>(new Set());
    const writePermit = yield* Semaphore.make(1);
    const knownBlocked = (nativeThreadId: string) =>
      Ref.get(blocked).pipe(Effect.map((ids) => ids.has(nativeThreadId)));
    const remember = (nativeThreadId: string) =>
      Ref.update(blocked, (ids) => new Set([...ids, nativeThreadId]));
    return {
      knownBlocked,
      // The runtime can install this fence inside its short lifecycle permit
      // without holding that permit across the independent durable write.
      blockLocally: remember,
      isBlocked: (nativeThreadId: string) =>
        Effect.gen(function* () {
          if (yield* knownBlocked(nativeThreadId)) return true;
          if (!callbacks || !(yield* callbacks.isBlocked(nativeThreadId)))
            // A live rejection can arrive while the durable read is pending.
            // Its sticky local fence wins over that earlier negative snapshot.
            return yield* knownBlocked(nativeThreadId);
          yield* remember(nativeThreadId);
          return true;
        }),
      markBlocked: (nativeThreadId: string) =>
        Effect.gen(function* () {
          yield* remember(nativeThreadId);
          yield* writePermit.withPermits(1)(
            Effect.gen(function* () {
              if ((yield* Ref.get(persisted)).has(nativeThreadId)) return;
              if (callbacks) yield* callbacks.markBlocked(nativeThreadId);
              yield* Ref.update(persisted, (ids) => new Set([...ids, nativeThreadId]));
            }),
          );
        }),
    };
  });

export interface CodexHistoryNotification {
  readonly method: string;
  readonly params?: unknown;
}

/**
 * Only a live exact-root, exact-latest-turn error can install the marker.
 * Native child routing and old terminal frames must never poison the parent
 * or a replacement turn. An absent turn identity is inconclusive.
 */
export function codexHistoryFailureBelongsToRoot(
  notification: CodexHistoryNotification,
  rootThreadId: string | undefined,
  latestRootTurnId: string | undefined,
): boolean {
  if (!rootThreadId || !latestRootTurnId) return false;
  const params = record(notification.params);
  if (params?.threadId !== rootThreadId) return false;
  if (notification.method === "error") {
    return (
      params.turnId === latestRootTurnId &&
      params.willRetry === false &&
      isCodexOversizedHistoryArgumentsError(record(params.error)?.message)
    );
  }
  const turn = record(params.turn);
  return (
    notification.method === "turn/completed" &&
    turn?.id === latestRootTurnId &&
    turn.status === "failed" &&
    isCodexOversizedHistoryArgumentsError(record(turn.error)?.message)
  );
}

/** Normalize only error surfaces, leaving every lifecycle identity intact. */
export function normalizeCodexBlockedHistoryNotification<T extends CodexHistoryNotification>(
  notification: T,
  rootThreadId: string,
): T {
  const params = record(notification.params);
  if (params?.threadId !== rootThreadId) return notification;
  if (notification.method === "error") {
    return {
      ...notification,
      params: {
        ...params,
        error: { message: CODEX_HISTORY_RECOVERY_REQUIRED_MESSAGE, codexErrorInfo: "other" },
        willRetry: false,
      },
    };
  }
  const turn = record(params.turn);
  if (notification.method !== "turn/completed" || turn?.status !== "failed") return notification;
  return {
    ...notification,
    params: {
      ...params,
      turn: {
        ...turn,
        error: { message: CODEX_HISTORY_RECOVERY_REQUIRED_MESSAGE, codexErrorInfo: "other" },
      },
    },
  };
}
