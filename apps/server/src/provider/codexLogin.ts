import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";
import type * as CodexClient from "effect-codex-app-server/client";
import { ProviderAdapterValidationError } from "./Errors.ts";

export const CODEX_LOGIN_ERRORS = {
  pending: "Codex sign-in is already in progress.",
  busy: "Close this account's Cafe chats before changing its native sign-in.",
  account:
    "Could not verify Codex's account status. Refresh this provider before trying sign-in again.",
  start: "Could not start Codex sign-in. Try again or run codex login in a terminal.",
  url: "Codex returned an invalid sign-in link. Update Codex before trying again.",
  browser:
    "Could not open your browser for Codex sign-in. Run codex login in a terminal, then refresh this provider.",
} as const;

const invalid = (issue: string) =>
  new ProviderAdapterValidationError({ provider: "codex", operation: "login", issue });

/** Authorization URLs stay inside the owner-triggered native connection. Never
 * project OAuth state, callback parameters or native errors into public data. */
export function codexLoginUrl(value: string): string | null {
  // oxlint-disable-next-line no-control-regex -- Refuse control bytes before parsing a provider-authored browser target.
  if (value.length > 4096 || /[\u0000-\u0020\u007f]/u.test(value)) return null;
  try {
    const url = new URL(value);
    return ["https://auth.openai.com", "https://chatgpt.com"].includes(url.origin) &&
      !url.username &&
      !url.password &&
      !url.hash
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function codexLoginFailureMessage(error: unknown): string {
  return error instanceof ProviderAdapterValidationError &&
    error.provider === "codex" &&
    error.operation === "login" &&
    Object.values(CODEX_LOGIN_ERRORS).some((issue) => issue === error.issue)
    ? error.issue
    : CODEX_LOGIN_ERRORS.start;
}

/** Official managed login protocol: https://learn.chatgpt.com/docs/app-server
 * The disposable app-server owns the callback and credentials; Cafe opens only
 * its checked URL and observes the exact loginId's terminal notification. No
 * thread, inference, token extraction or automatic login retry is involved.
 * The driver supplies its admitted auth source home, not its copied auth overlay.
 */
export const makeCodexLogin = Effect.fn("makeCodexLogin")(function* (options: {
  readonly withClient: (
    use: (client: CodexClient.CodexAppServerClientShape) => Effect.Effect<void, unknown>,
    onTermination: Effect.Effect<void>,
  ) => Effect.Effect<void, unknown, Scope.Scope>;
  readonly hasSessions: Effect.Effect<boolean>;
  readonly refresh: Effect.Effect<unknown>;
  readonly openUrl: (url: string) => Effect.Effect<void, unknown>;
}) {
  const instanceScope = yield* Effect.scope;
  let pending = false;
  return (hasOwnedSessions: Effect.Effect<boolean, unknown> = Effect.succeed(false)) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (pending) return yield* invalid(CODEX_LOGIN_ERRORS.pending);
        pending = true;
        const acknowledged = yield* Deferred.make<
          "authenticated" | "started",
          ProviderAdapterValidationError
        >();
        const completed = yield* Deferred.make<boolean, ProviderAdapterValidationError>();
        const worker = options
          .withClient(
            (client) =>
              Effect.gen(function* () {
                const account = yield* client.request("account/read", {}).pipe(
                  Effect.timeout(15_000),
                  Effect.mapError(() => invalid(CODEX_LOGIN_ERRORS.account)),
                );
                if (account.account) {
                  yield* options.refresh;
                  yield* Deferred.succeed(acknowledged, "authenticated");
                  return;
                }
                if (
                  (yield* options.hasSessions) ||
                  (yield* hasOwnedSessions.pipe(
                    Effect.timeout(15_000),
                    Effect.mapError(() => invalid(CODEX_LOGIN_ERRORS.account)),
                  ))
                )
                  return yield* invalid(CODEX_LOGIN_ERRORS.busy);
                let loginId: string | undefined;
                // A native completion may precede the start response. Retain one bounded
                // early receipt; unrelated IDs never authorize a refresh or successful login.
                let early: { readonly loginId: string; readonly success: boolean } | undefined;
                yield* client.handleServerNotification("account/login/completed", (event) => {
                  if (!event.loginId || event.loginId.length > 128) return Effect.void;
                  if (loginId === undefined) {
                    early = { loginId: event.loginId, success: event.success };
                    return Effect.void;
                  }
                  return event.loginId === loginId
                    ? Deferred.succeed(completed, event.success).pipe(Effect.asVoid)
                    : Effect.void;
                });
                const result = yield* client
                  .request("account/login/start", { type: "chatgpt" })
                  .pipe(
                    Effect.timeout(15_000),
                    Effect.mapError(() => invalid(CODEX_LOGIN_ERRORS.start)),
                  );
                if (result.type !== "chatgpt" || !result.loginId || result.loginId.length > 128)
                  return yield* invalid(CODEX_LOGIN_ERRORS.start);
                loginId = result.loginId;
                let successful = false;
                yield* Effect.gen(function* () {
                  const url = codexLoginUrl(result.authUrl);
                  if (!url) return yield* invalid(CODEX_LOGIN_ERRORS.url);
                  if (early?.loginId === loginId) yield* Deferred.succeed(completed, early.success);
                  early = undefined;
                  yield* options.openUrl(url).pipe(
                    Effect.timeout(15_000),
                    Effect.mapError(() => invalid(CODEX_LOGIN_ERRORS.browser)),
                  );
                  yield* Deferred.succeed(acknowledged, "started");
                  successful = yield* Deferred.await(completed).pipe(Effect.timeout(10 * 60_000));
                  if (successful) {
                    // Completion belongs to this attempt; the ordinary probe is still the
                    // authority for the account badge and copied shadow credentials.
                    yield* options.refresh;
                  }
                }).pipe(
                  Effect.ensuring(
                    Effect.suspend(() =>
                      successful
                        ? Effect.void
                        : client
                            .request("account/login/cancel", { loginId: result.loginId })
                            .pipe(Effect.timeout(3000), Effect.ignore),
                    ),
                  ),
                );
              }),
            // Transport death after login/start has no outstanding request to
            // reject. Retire the attempt immediately instead of holding the
            // single-flight reservation until the human completion deadline.
            Deferred.fail(completed, invalid(CODEX_LOGIN_ERRORS.start)).pipe(Effect.asVoid),
          )
          .pipe(
            Effect.scoped,
            // Startup/initialize are also bounded. After acknowledgement, the native
            // attempt retains its separate nonrenewable ten-minute completion budget.
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                const error = invalid(codexLoginFailureMessage(Cause.squash(cause)));
                yield* Deferred.fail(acknowledged, error);
                if (Cause.hasInterrupts(cause)) return yield* Effect.interrupt;
              }),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                pending = false;
              }),
            ),
          );
        const fiber = yield* Effect.forkIn(worker, instanceScope);
        return yield* restore(Deferred.await(acknowledged).pipe(Effect.timeout(60_000))).pipe(
          Effect.mapError((error) =>
            error instanceof ProviderAdapterValidationError
              ? error
              : invalid(CODEX_LOGIN_ERRORS.start),
          ),
          Effect.onError(() => Fiber.interrupt(fiber)),
        );
      }),
    );
});
