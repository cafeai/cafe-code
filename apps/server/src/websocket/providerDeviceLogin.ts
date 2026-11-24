import {
  ServerProviderLoginError,
  type ProviderInstanceConfig,
  type ServerProviderDeviceLoginEvent,
  type ServerProviderLoginCodeInput,
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
import { GEMINI_LOGIN_ERRORS, geminiLoginFailureMessage } from "../provider/geminiLogin.ts";
import type { ProviderAdapterError } from "../provider/Errors.ts";
import { canLoginProviderDeviceCode } from "./providerLoginAccess.ts";

function deniedReasonForDriver(driver: string | undefined): string {
  return driver === "gemini"
    ? "Provider sign-in requires the enabled Gemini account and a current authenticated connection over HTTPS or the same machine."
    : "Provider sign-in requires the enabled Codex account and a current authenticated connection over HTTPS or the same machine.";
}

/** Private, non-replaying RPC. No device code, OAuth link, or verification link
 * enters a shared snapshot, trace, native daemon command ledger, settings file
 * or reconnect cache. */
export function providerDeviceLogin<AccountError, SessionError>(
  input: ServerProviderLoginInput,
  options: {
    readonly role: string;
    readonly secureSecretTransport: boolean;
    readonly getAccount: Effect.Effect<ProviderInstanceConfig | undefined, AccountError>;
    readonly validateSession: Effect.Effect<void, SessionError>;
    readonly invalidations: ReadonlyArray<Stream.Stream<unknown>>;
    readonly expiresAt?: number;
    readonly ownedLoginIds?: Set<string>;
    readonly listSessions: Effect.Effect<ReadonlyArray<ProviderSession>>;
    readonly login?: (
      hasSessions: Effect.Effect<ReadonlyArray<ProviderSession>, ServerProviderLoginError>,
    ) => Stream.Stream<ServerProviderDeviceLoginEvent, ProviderAdapterError>;
  },
) {
  let account: ProviderInstanceConfig | undefined;
  const denied = () =>
    new ServerProviderLoginError({
      instanceId: input.instanceId,
      reason: deniedReasonForDriver(account?.driver),
    });
  return Stream.unwrap(
    Effect.gen(function* () {
      if ((options.role !== "owner" && options.role !== "client") || !options.secureSecretTransport)
        return yield* denied();
      const revoked = yield* Deferred.make<never, ServerProviderLoginError>();
      const registeredLoginIds = new Set<string>();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const loginId of registeredLoginIds) {
            options.ownedLoginIds?.delete(loginId);
          }
          registeredLoginIds.clear();
        }),
      );
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
          reason:
            account?.driver === "gemini"
              ? "Update the Cafe server to use remote Gemini sign-in."
              : "Update the Cafe server to use Codex device-code sign-in.",
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
              reason:
                account?.driver === "gemini"
                  ? geminiLoginFailureMessage(error)
                  : codexLoginFailureMessage(error),
            }),
        ),
        Stream.mapEffect((event) =>
          validate.pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (event.type === "oauth-code" && options.ownedLoginIds) {
                  options.ownedLoginIds.add(event.loginId);
                  registeredLoginIds.add(event.loginId);
                }
              }),
            ),
            Effect.as(event),
          ),
        ),
        Stream.interruptWhen(Deferred.await(revoked)),
      );
    }),
  ).pipe(Stream.provideService(References.TracerEnabled, false));
}

/** Private, trace-disabled RPC that delivers a pasted OAuth authorization code
 * or callback URL to the exact pending login owned by this connection. */
export function submitProviderLoginCode<AccountError, SessionError>(
  input: ServerProviderLoginCodeInput,
  options: {
    readonly role: string;
    readonly secureSecretTransport: boolean;
    readonly getAccount: Effect.Effect<ProviderInstanceConfig | undefined, AccountError>;
    readonly validateSession: Effect.Effect<void, SessionError>;
    readonly expiresAt?: number;
    readonly ownedLoginIds: ReadonlySet<string>;
    readonly submit?: (
      input: ServerProviderLoginCodeInput,
    ) => Effect.Effect<void, ProviderAdapterError>;
  },
) {
  const denied = () =>
    new ServerProviderLoginError({
      instanceId: input.instanceId,
      reason: deniedReasonForDriver("gemini"),
    });
  return Effect.gen(function* () {
    if ((options.role !== "owner" && options.role !== "client") || !options.secureSecretTransport) {
      return yield* denied();
    }
    yield* options.validateSession.pipe(Effect.mapError(denied));
    if (options.expiresAt !== undefined && (yield* Clock.currentTimeMillis) >= options.expiresAt) {
      return yield* denied();
    }
    const account = yield* options.getAccount.pipe(Effect.mapError(denied));
    if (
      account?.driver !== "gemini" ||
      !canLoginProviderDeviceCode({
        role: options.role,
        secureSecretTransport: options.secureSecretTransport,
        instance: account,
      })
    ) {
      return yield* denied();
    }
    if (!options.ownedLoginIds.has(input.loginId)) {
      return yield* new ServerProviderLoginError({
        instanceId: input.instanceId,
        reason: GEMINI_LOGIN_ERRORS.expired,
      });
    }
    if (!options.submit) {
      return yield* new ServerProviderLoginError({
        instanceId: input.instanceId,
        reason: "Update the Cafe server to use remote Gemini sign-in.",
      });
    }
    yield* options.submit(input).pipe(
      Effect.mapError(
        (error) =>
          new ServerProviderLoginError({
            instanceId: input.instanceId,
            reason: geminiLoginFailureMessage(error),
          }),
      ),
    );
  }).pipe(Effect.provideService(References.TracerEnabled, false));
}
