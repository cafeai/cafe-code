import type { ProviderEvent, ServerProvider } from "@cafecode/contracts";
import * as Effect from "effect/Effect";

export const CODEX_SIGN_IN_REQUIRED_MESSAGE =
  "Codex CLI is not authenticated. Run `codex login` and try again.";

/** A native auth-manager record, not arbitrary tool/MCP/provider error prose. */
const REVOKED_REFRESH_TOKEN =
  /^\d{4}-\d{2}-\d{2}T[\d:.]+Z ERROR codex_login::auth::manager: Failed to refresh token: Your access token could not be refreshed because your refresh token was revoked\. Please log out and sign in again\.$/u;

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

export function codexAuthenticationObservation(event: ProviderEvent): boolean | undefined {
  if (event.method === "process/stderr") {
    return typeof event.message === "string" &&
      event.message.length <= 2048 &&
      REVOKED_REFRESH_TOKEN.test(event.message)
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
