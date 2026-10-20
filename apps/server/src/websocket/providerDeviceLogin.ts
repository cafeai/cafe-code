import {
  ServerProviderLoginError,
  type ProviderInstanceConfig,
  type ServerProviderDeviceLoginEvent,
  type ServerProviderLoginInput,
  type ProviderSession,
} from "@cafecode/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as References from "effect/References";
import * as Stream from "effect/Stream";
import { codexLoginFailureMessage } from "../provider/codexLogin.ts";
import type { ProviderAdapterError } from "../provider/Errors.ts";
import { canLoginProviderDeviceCode } from "./providerLoginAccess.ts";

/** Private, non-replaying RPC. No device code enters a shared snapshot,
 * trace, native daemon command ledger, settings file or reconnect cache. */
export function providerDeviceLogin<AccountError, SessionError>(
  input: ServerProviderLoginInput,
  options: {
    readonly role: string;
    readonly secureSecretTransport: boolean;
    readonly getAccount: Effect.Effect<ProviderInstanceConfig | undefined, AccountError>;
    readonly validateSession: Effect.Effect<void, SessionError>;
    readonly invalidations: ReadonlyArray<Stream.Stream<unknown>>;
    readonly expiresAt?: number;
    readonly listSessions: Effect.Effect<ReadonlyArray<ProviderSession>>;
    readonly login?: (
      hasSessions: Effect.Effect<ReadonlyArray<ProviderSession>, ServerProviderLoginError>,
    ) => Stream.Stream<ServerProviderDeviceLoginEvent, ProviderAdapterError>;
  },
) {
  const denied = () =>
    new ServerProviderLoginError({
      instanceId: input.instanceId,
      reason:
        "Provider sign-in requires the enabled Codex account and a current authenticated connection over HTTPS or the same machine.",
    });
  return Stream.unwrap(
    Effect.gen(function* () {
      if ((options.role !== "owner" && options.role !== "client") || !options.secureSecretTransport)
        return yield* denied();
      const revoked = yield* Deferred.make<never, ServerProviderLoginError>();
      let account: ProviderInstanceConfig | undefined;
      const validate = Effect.gen(function* () {
        if (yield* Deferred.isDone(revoked)) return yield* denied();
        yield* options.validateSession.pipe(Effect.mapError(denied));
        const current = yield* options.getAccount.pipe(Effect.mapError(denied));
        if (
          (yield* Deferred.isDone(revoked)) ||
          (options.expiresAt !== undefined && (yield* Clock.currentTimeMillis) >= options.expiresAt)
        )
          return yield* denied();
        if (
          !canLoginProviderDeviceCode({
            role: options.role,
            secureSecretTransport: options.secureSecretTransport,
            instance: current,
          }) ||
          (account !== undefined && !Equal.equals(account, current))
        )
          return yield* denied();
        account = current;
      });
      // Install observers before awaiting the initial admission reads. Revocation
      // is terminal even if projected connection/account state has not caught up.
      for (const source of options.invalidations)
        yield* Stream.runForEach(source, () => validate).pipe(
          Effect.catch(() => Deferred.fail(revoked, denied())),
          Effect.forkScoped({ startImmediately: true }),
        );
      if (options.expiresAt !== undefined) {
        const remaining = options.expiresAt - (yield* Clock.currentTimeMillis);
        yield* Effect.sleep(Math.max(0, remaining)).pipe(
          Effect.andThen(Deferred.fail(revoked, denied())),
          Effect.forkScoped,
        );
      }
      yield* validate;
      if (!options.login)
        return yield* new ServerProviderLoginError({
          instanceId: input.instanceId,
          reason: "Update the Cafe server to use Codex device-code sign-in.",
        });
      const inventory = Effect.gen(function* () {
        yield* validate;
        const sessions = yield* options.listSessions;
        yield* validate;
        return sessions;
      }).pipe(
        Effect.catch(() =>
          Deferred.fail(revoked, denied()).pipe(Effect.andThen(Effect.fail(denied()))),
        ),
      );
      return options.login(inventory).pipe(
        Stream.mapError(
          (error) =>
            new ServerProviderLoginError({
              instanceId: input.instanceId,
              reason: codexLoginFailureMessage(error),
            }),
        ),
        Stream.mapEffect((event) => validate.pipe(Effect.as(event))),
        Stream.interruptWhen(Deferred.await(revoked)),
      );
    }),
  ).pipe(Stream.provideService(References.TracerEnabled, false));
}
