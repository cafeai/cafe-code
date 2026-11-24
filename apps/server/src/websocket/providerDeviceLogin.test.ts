import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ServerProviderDeviceLoginEvent,
} from "@cafecode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ProviderAdapterValidationError } from "../provider/Errors.ts";
import { providerDeviceLogin, submitProviderLoginCode } from "./providerDeviceLogin.ts";

const instanceId = ProviderInstanceId.make("codex_work");
const instructions: ServerProviderDeviceLoginEvent = {
  type: "device-code",
  verificationUrl: "https://auth.openai.com/codex/device",
  userCode: "ABCD-12345",
};
const fixture = Effect.fn("deviceLoginAccess.fixture")(function* (
  input: {
    role?: string;
    secure?: boolean;
    expired?: boolean;
    expiresAt?: number;
    enabled?: boolean;
  } = {},
) {
  const invalidations = yield* PubSub.unbounded<void>();
  const shown = yield* Deferred.make<void>();
  const finished = yield* Deferred.make<void>();
  const retired = yield* Deferred.make<void>();
  const state = {
    starts: 0,
    submissions: 0,
    active: !input.expired,
    account: { driver: ProviderDriverKind.make("codex"), enabled: input.enabled ?? true } as
      | ProviderInstanceConfig
      | undefined,
  };
  const events: ServerProviderDeviceLoginEvent[] = [];
  const stream = providerDeviceLogin(
    { instanceId },
    {
      role: input.role ?? "owner",
      secureSecretTransport: input.secure ?? true,
      validateSession: Effect.suspend(() =>
        state.active ? Effect.void : Effect.fail("private session failure"),
      ),
      getAccount: Effect.sync(() => state.account),
      invalidations: [Stream.fromPubSub(invalidations)],
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      listSessions: Effect.succeed([]),
      login: (inventory) =>
        Stream.unwrap(
          Effect.gen(function* () {
            state.starts++;
            yield* Effect.addFinalizer(() => Deferred.succeed(retired, undefined));
            yield* inventory.pipe(
              Effect.mapError(
                () =>
                  new ProviderAdapterValidationError({
                    provider: "codex",
                    operation: "login",
                    issue: "private guard failure",
                  }),
              ),
            );
            state.submissions++;
            return Stream.concat(
              Stream.make(instructions),
              Stream.fromEffect(
                Deferred.await(finished).pipe(Effect.as({ type: "authenticated" as const })),
              ),
            );
          }),
        ),
    },
  );
  const run = stream.pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        events.push(event);
        yield* Deferred.succeed(shown, undefined);
      }),
    ),
  );
  return {
    state,
    events,
    run,
    shown,
    finished,
    retired,
    invalidate: PubSub.publish(invalidations, undefined),
  };
});

describe("private device login access", () => {
  for (const input of [
    { role: "viewer" },
    { role: "" },
    { secure: false },
    { role: "client", secure: false },
    { expired: true },
    { role: "client", expired: true },
    { enabled: false },
    { role: "client", enabled: false },
  ])
    it.effect(`refuses ${JSON.stringify(input)} before opening native login`, () =>
      Effect.gen(function* () {
        const f = yield* fixture(input);
        expect(yield* f.run.pipe(Effect.flip)).toMatchObject({ _tag: "ServerProviderLoginError" });
        expect(f.state.starts).toBe(0);
        expect(f.events).toEqual([]);
      }),
    );

  for (const role of ["owner", "client"]) {
    it.effect(`delivers instructions and completion to the admitted ${role} subscriber`, () =>
      Effect.gen(function* () {
        const f = yield* fixture({ role });
        const fiber = yield* Effect.forkChild(f.run);
        yield* Deferred.await(f.shown);
        expect(f.events).toEqual([instructions]);
        yield* Deferred.succeed(f.finished, undefined);
        yield* Fiber.join(fiber);
        expect(f.events).toEqual([instructions, { type: "authenticated" }]);
        expect(f.state.starts).toBe(1);
        expect(f.state.submissions).toBe(1);
        expect(yield* Deferred.isDone(f.retired)).toBe(true);
      }),
    );

    it.effect(
      `releases instructions only to the admitted ${role} subscriber and joins cancellation`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture({ role });
          const fiber = yield* Effect.forkChild(f.run);
          yield* Deferred.await(f.shown);
          expect(f.events).toEqual([instructions]);
          expect(f.state.submissions).toBe(1);
          yield* Fiber.interrupt(fiber);
          expect(yield* Deferred.isDone(f.retired)).toBe(true);
        }),
    );

    for (const change of ["revocation", "replacement", "disable"] as const)
      it.effect(`retires a waiting ${role} native attempt on ${change}`, () =>
        Effect.gen(function* () {
          const f = yield* fixture({ role });
          const fiber = yield* Effect.forkChild(f.run);
          yield* Deferred.await(f.shown);
          if (change === "revocation") f.state.active = false;
          else
            f.state.account = {
              ...f.state.account!,
              ...(change === "disable"
                ? { enabled: false }
                : { config: { homePath: "another-account" } }),
            };
          yield* f.invalidate;
          expect(yield* Fiber.join(fiber).pipe(Effect.flip)).toMatchObject({
            _tag: "ServerProviderLoginError",
          });
          expect(yield* Deferred.isDone(f.retired)).toBe(true);
          yield* Deferred.succeed(f.finished, undefined);
          expect(f.events).toEqual([instructions]);
          expect(f.state.submissions).toBe(1);
        }),
      );

    it.effect(`retires the native attempt at the ${role}'s exact session expiry`, () =>
      Effect.gen(function* () {
        const f = yield* fixture({ role, expiresAt: (yield* Clock.currentTimeMillis) + 1000 });
        const fiber = yield* Effect.forkChild(f.run);
        yield* Deferred.await(f.shown);
        yield* TestClock.adjust(1000);
        expect(yield* Fiber.join(fiber).pipe(Effect.flip)).toMatchObject({
          _tag: "ServerProviderLoginError",
        });
        expect(yield* Deferred.isDone(f.retired)).toBe(true);
        expect(f.events).toEqual([instructions]);
      }),
    );

    it.effect(`revalidates the ${role} session immediately before releasing a completion`, () =>
      Effect.gen(function* () {
        const f = yield* fixture({ role });
        const fiber = yield* Effect.forkChild(f.run);
        yield* Deferred.await(f.shown);
        f.state.active = false;
        yield* Deferred.succeed(f.finished, undefined);
        yield* Fiber.join(fiber).pipe(Effect.flip);
        expect(f.events).toEqual([instructions]);
        expect(yield* Deferred.isDone(f.retired)).toBe(true);
      }),
    );
  }

  it.effect(
    "binds Gemini login code submission to the owning connection and validates access",
    () =>
      Effect.gen(function* () {
        const geminiId = ProviderInstanceId.make("gemini_work");
        const geminiAccount: ProviderInstanceConfig = {
          driver: ProviderDriverKind.make("gemini"),
          enabled: true,
        };
        const ownedLoginIds = new Set<string>();
        const gotOAuth = yield* Deferred.make<string>();
        const codeReceived = yield* Deferred.make<string>();
        const stream = providerDeviceLogin(
          { instanceId: geminiId },
          {
            role: "client",
            secureSecretTransport: true,
            validateSession: Effect.void,
            getAccount: Effect.succeed(geminiAccount),
            invalidations: [],
            ownedLoginIds,
            listSessions: Effect.succeed([]),
            login: () =>
              Stream.concat(
                Stream.make({
                  type: "oauth-code" as const,
                  loginId: "login-uuid-1",
                  authorizationUrl:
                    "https://accounts.google.com/o/oauth2/auth?client_id=x&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code",
                }),
                Stream.fromEffect(
                  Deferred.await(codeReceived).pipe(Effect.as({ type: "authenticated" as const })),
                ),
              ),
          },
        );

        const fiber = yield* stream.pipe(
          Stream.runForEach((event) =>
            event.type === "oauth-code" ? Deferred.succeed(gotOAuth, event.loginId) : Effect.void,
          ),
          Effect.forkChild,
        );

        const loginId = yield* Deferred.await(gotOAuth);
        expect(ownedLoginIds.has(loginId)).toBe(true);

        // Another connection without this loginId in its owned set is refused.
        expect(
          yield* submitProviderLoginCode(
            { instanceId: geminiId, loginId, code: "auth-code-1" },
            {
              role: "client",
              secureSecretTransport: true,
              validateSession: Effect.void,
              getAccount: Effect.succeed(geminiAccount),
              ownedLoginIds: new Set(),
              submit: () => Effect.void,
            },
          ).pipe(Effect.flip),
        ).toMatchObject({ _tag: "ServerProviderLoginError" });

        // Insecure transport or viewer role is refused even with the right loginId.
        expect(
          yield* submitProviderLoginCode(
            { instanceId: geminiId, loginId, code: "auth-code-1" },
            {
              role: "viewer",
              secureSecretTransport: true,
              validateSession: Effect.void,
              getAccount: Effect.succeed(geminiAccount),
              ownedLoginIds,
              submit: () => Effect.void,
            },
          ).pipe(Effect.flip),
        ).toMatchObject({ _tag: "ServerProviderLoginError" });

        // The owning authenticated connection succeeds and completes the stream.
        yield* submitProviderLoginCode(
          { instanceId: geminiId, loginId, code: "auth-code-1" },
          {
            role: "client",
            secureSecretTransport: true,
            validateSession: Effect.void,
            getAccount: Effect.succeed(geminiAccount),
            ownedLoginIds,
            submit: (submitted) =>
              Deferred.succeed(codeReceived, submitted.code).pipe(Effect.asVoid),
          },
        );

        yield* Fiber.join(fiber);
        expect(yield* Deferred.await(codeReceived)).toBe("auth-code-1");
        expect(ownedLoginIds.has(loginId)).toBe(false);
      }),
  );
});
