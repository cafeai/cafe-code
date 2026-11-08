import type { ProviderEvent, ProviderRuntimeEvent, ServerProvider } from "@cafecode/contracts";
import * as Effect from "effect/Effect";

export const CODEX_SIGN_IN_REQUIRED_MESSAGE =
  "Codex CLI is not authenticated. Run `codex login` and try again.";

/**
 * A native auth-manager record, not arbitrary tool/MCP/provider error prose.
 * codex-rs login maps the permanent refresh failures (revoked, reused/"already
 * used" and expired refresh tokens) to these exact fixed messages; each one
 * means the saved login can never be renewed without signing in again.
 */
const PERMANENT_REFRESH_FAILURE =
  /^\d{4}-\d{2}-\d{2}T[\d:.]+Z ERROR codex_login::auth::manager: Failed to refresh token: Your access token could not be refreshed because your refresh token (?:was revoked|was already used|has expired)\. Please log out and sign in again\.$/u;

function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const field = Object.getOwnPropertyDescriptor(value, key);
    return field && "value" in field ? field.value : undefined;
  } catch {
    return undefined;
  }
}

function unauthorized(error: unknown): boolean {
  const info = own(error, "codexErrorInfo");
  return (
    info === "unauthorized" ||
    [
      "httpConnectionFailed",
      "responseStreamConnectionFailed",
      "responseStreamDisconnected",
      "responseTooManyFailedAttempts",
    ].some((kind) => own(own(info, kind), "httpStatusCode") === 401)
  );
}

/**
 * Cafe-synthesized resume/reconciliation snapshots (see `snapshotEventId` in
 * CodexSessionRuntime) replay a thread's persisted turns, including an old
 * turn that failed before the user signed in again. That replay is history,
 * not a fresh native observation, so it must never reject the current login
 * or retire the freshly resumed app-server.
 */
function isCodexSnapshotReplay(id: unknown): boolean {
  return typeof id === "string" && id.startsWith("codex-snapshot:");
}

export function codexAuthenticationObservation(event: ProviderEvent): boolean | undefined {
  if (isCodexSnapshotReplay(event.id)) return undefined;
  if (event.method === "process/stderr") {
    return typeof event.message === "string" &&
      event.message.length <= 2048 &&
      PERMANENT_REFRESH_FAILURE.test(event.message)
      ? false
      : undefined;
  }
  if (event.method === "error" && own(event.payload, "willRetry") === false) {
    return unauthorized(own(event.payload, "error")) ? false : undefined;
  }
  if (event.method === "turn/completed") {
    const turn = own(event.payload, "turn");
    if (own(turn, "status") === "completed") return true;
    if (own(turn, "status") === "failed" && unauthorized(own(turn, "error"))) return false;
  }
  return undefined;
}

/**
 * The same classification applied to a canonical runtime event received from
 * another process (the provider daemon). Only the exact native notification
 * copy retained in `raw` qualifies; stderr records keep their fixed message in
 * the canonical payload because their raw payload is intentionally emptied.
 */
export function codexRuntimeEventAuthenticationObservation(
  event: ProviderRuntimeEvent,
): boolean | undefined {
  if (isCodexSnapshotReplay(event.eventId)) return undefined;
  const raw = event.raw;
  if (raw?.source !== "codex.app-server.notification" || raw.method === undefined) return undefined;
  if (raw.method === "process/stderr") {
    const message = own(event.payload, "message");
    return codexAuthenticationObservation({
      method: raw.method,
      ...(typeof message === "string" ? { message } : {}),
    } as ProviderEvent);
  }
  return codexAuthenticationObservation({
    method: raw.method,
    payload: raw.payload,
  } as ProviderEvent);
}

/** Exact credential revisions stay private and volatile. Credential rotation
 * retires old refusals without deleting credentials or logging out a process. */
export function makeCodexAuthenticationState(readIdentity: Effect.Effect<string | undefined>) {
  let rejectedIdentity: string | undefined;
  const reject = (identity: string): Effect.Effect<boolean> =>
    readIdentity.pipe(
      Effect.map((current) => {
        if (current !== identity || rejectedIdentity === identity) return false;
        rejectedIdentity = identity;
        return true;
      }),
    );
  const isRejected = readIdentity.pipe(
    Effect.map((current) => current !== undefined && current === rejectedIdentity),
  );
  const isRejectedIn = (readOtherIdentity: Effect.Effect<string | undefined>) =>
    Effect.gen(function* () {
      const current = yield* readIdentity;
      if (current === undefined || current !== rejectedIdentity) return false;
      return (yield* readOtherIdentity) === current;
    });
  const capture = readIdentity.pipe(
    Effect.map((identity) => (authenticated: boolean): Effect.Effect<boolean> => {
      if (identity === undefined) return Effect.succeed(false);
      if (!authenticated) return reject(identity);
      return readIdentity.pipe(
        Effect.map((current) => {
          if (current !== identity || rejectedIdentity !== identity) return false;
          rejectedIdentity = undefined;
          return true;
        }),
      );
    }),
  );
  return { reject, isRejected, isRejectedIn, capture };
}

export function withCodexSignInRequired(snapshot: ServerProvider): ServerProvider {
  const { accountRateLimits: _accountRateLimits, ...rest } = snapshot;
  return {
    ...rest,
    status: "error",
    auth: { status: "unauthenticated" },
    message: CODEX_SIGN_IN_REQUIRED_MESSAGE,
  };
}
