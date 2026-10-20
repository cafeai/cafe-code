import type {
  ProviderInstanceId,
  ProviderSession,
  ServerProviderLoginResult,
  ServerProviderDeviceLoginEvent,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { ProviderInstance } from "./ProviderDriver.ts";
import { ProviderAdapterValidationError } from "./Errors.ts";

const ownerChanged = () =>
  new ProviderAdapterValidationError({
    provider: "account",
    operation: "login",
    issue: "The selected provider account changed. Refresh this provider before signing in.",
  });

/** Login owns no chat: run its temporary native connection in the backend
 * instance whose snapshot is streamed to Settings. A daemon's independent
 * snapshot refresh cannot update that stream. Keep the daemon's actual session
 * inventory as the account-change fence, not the backend's unused chat adapter.
 * The exact captured instance owns completion, refresh and scope cleanup; a
 * replacement never inherits this action or its pending native connection.
 */
export const loginBoundProviderAccount = Effect.fn("loginBoundProviderAccount")(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly getInstance: () => Effect.Effect<ProviderInstance | undefined>;
  readonly listSessions: Effect.Effect<ReadonlyArray<ProviderSession>>;
}) {
  const instance = yield* input.getInstance();
  if (!instance?.enabled || instance.instanceId !== input.instanceId || !instance.adapter.login)
    return yield* ownerChanged();
  const hasOwnedSessions = Effect.gen(function* () {
    if ((yield* input.getInstance()) !== instance) return yield* ownerChanged();
    const sessions = yield* input.listSessions;
    // Inventory can await a remote owner. Recheck the exact backend instance
    // after that wait and before allowing a native account-changing call.
    if ((yield* input.getInstance()) !== instance) return yield* ownerChanged();
    return sessions.some(
      (session) =>
        session.providerInstanceId === input.instanceId ||
        (session.providerInstanceId === undefined && session.provider === instance.driverKind),
    );
  });
  const outcome = yield* instance.adapter.login(hasOwnedSessions);
  if ((yield* input.getInstance()) !== instance) return yield* ownerChanged();
  return {
    instanceId: input.instanceId,
    provider: instance.driverKind,
    command: instance.driverKind === "codex" ? "codex login" : "axiomcli native sign-in",
    outcome,
    message:
      outcome === "authenticated"
        ? "Already signed in. Provider status has been refreshed."
        : "Opened native sign-in in your browser.",
  } satisfies ServerProviderLoginResult;
});

/** A one-shot subscriber owns the temporary login, never the daemon ledger. */
export const loginBoundProviderDeviceAccount = <SessionError>(input: {
  readonly instanceId: ProviderInstanceId;
  readonly getInstance: () => Effect.Effect<ProviderInstance | undefined>;
  readonly listSessions: Effect.Effect<ReadonlyArray<ProviderSession>, SessionError>;
}) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const instance = yield* input.getInstance();
      if (
        !instance?.enabled ||
        instance.instanceId !== input.instanceId ||
        instance.driverKind !== "codex" ||
        !instance.adapter.loginDeviceCode
      )
        return yield* ownerChanged();
      const current = Effect.gen(function* () {
        if ((yield* input.getInstance()) !== instance) return yield* ownerChanged();
      });
      const hasOwnedSessions = Effect.gen(function* () {
        yield* current;
        const sessions = yield* input.listSessions;
        yield* current;
        return sessions.some(
          (session) =>
            session.providerInstanceId === input.instanceId ||
            (session.providerInstanceId === undefined && session.provider === instance.driverKind),
        );
      });
      return instance.adapter
        .loginDeviceCode(hasOwnedSessions)
        .pipe(
          Stream.mapEffect((event: ServerProviderDeviceLoginEvent) =>
            current.pipe(Effect.as(event)),
          ),
        );
    }),
  );
