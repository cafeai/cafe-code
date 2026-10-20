import * as ProviderJsonSchema from "effect/Schema";
import * as Data from "effect/Data";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type * as CodexClient from "effect-codex-app-server/client";
import type { ServerProviderDeviceLoginEvent } from "@cafecode/contracts";
import { ProviderAdapterValidationError } from "./Errors.ts";
import {
  CODEX_LOGIN_ERRORS,
  codexLoginFailureMessage,
  codexLoginUrl,
  makeCodexLogin,
  codexDeviceLoginInstructions,
  supportsCodexDeviceCodeLogin,
} from "./codexLogin.ts";

const encodeProviderJsonString = ProviderJsonSchema.encodeUnknownSync(
  ProviderJsonSchema.UnknownFromJsonString,
);

class LoginFixtureFailure extends Data.TaggedError("LoginFixtureFailure")<{
  readonly message: string;
}> {
  override name = "Error";
}

const authUrl = "https://auth.openai.com/oauth/authorize?state=private-fixture-state";
const loginId = "fixture-owned-login";

const fixture = Effect.fn("codexLogin.test.fixture")(function* (
  input: {
    readonly authenticated?: boolean;
    readonly requiresReauthentication?: boolean;
    readonly busy?: boolean;
    readonly url?: string;
    readonly browserFailure?: boolean;
    readonly startFailure?: boolean;
    readonly earlyCompletion?: boolean;
    readonly holdStart?: boolean;
    readonly deviceUrl?: string;
    readonly userCode?: string;
    readonly unsupported?: boolean;
    readonly ownerScope?: Scope.Scope;
  } = {},
) {
  const released = yield* Deferred.make<void>();
  const startEntered = yield* Deferred.make<void>();
  const startGate = yield* Deferred.make<void>();
  const calls: { method: string; params: unknown }[] = [];
  const opened: string[] = [];
  const state = { refreshes: 0, requiresReauthentication: input.requiresReauthentication ?? false };
  let notification:
    | ((event: {
        loginId?: string | null;
        success: boolean;
        error?: string;
      }) => Effect.Effect<void>)
    | undefined;
  let terminate = Effect.void;
  const complete = (id: string | null | undefined, success = true) =>
    Effect.suspend(() =>
      notification!({
        ...(id === undefined ? {} : { loginId: id }),
        success,
        error: "private-native-error",
      }),
    );
  const client = {
    handleServerNotification: (method: string, handler: typeof notification) =>
      Effect.sync(() => {
        expect(method).toBe("account/login/completed");
        notification = handler;
      }),
    request: (method: string, params: unknown) =>
      Effect.gen(function* () {
        calls.push({ method, params });
        if (method === "account/read")
          return { account: input.authenticated ? { type: "chatgpt" } : null };
        if (method === "account/login/start") {
          yield* Deferred.succeed(startEntered, undefined);
          if (input.holdStart) yield* Deferred.await(startGate);
          if (input.startFailure)
            return yield* Effect.fail(new LoginFixtureFailure({ message: authUrl }));
          if (input.earlyCompletion) yield* complete(loginId);
          return (params as { type: string }).type === "chatgptDeviceCode"
            ? {
                type: "chatgptDeviceCode",
                loginId,
                verificationUrl: input.deviceUrl ?? "https://auth.openai.com/codex/device",
                userCode: input.userCode ?? "ABCD-12345",
              }
            : { type: "chatgpt", loginId, authUrl: input.url ?? authUrl };
        }
        if (method === "account/login/cancel" || method === "account/logout") return {};
        return yield* Effect.die(new Error(`Unexpected method ${method}`));
      }),
  } as unknown as CodexClient.CodexAppServerClientShape;
  const controller = makeCodexLogin({
    supportsDeviceCode: () => !input.unsupported,
    withClient: (use, onTermination) =>
      Effect.gen(function* () {
        terminate = onTermination;
        yield* Effect.addFinalizer(() => Deferred.succeed(released, undefined));
        yield* use(client);
      }),
    hasSessions: Effect.succeed(input.busy ?? false),
    requiresReauthentication: Effect.sync(() => state.requiresReauthentication),
    refresh: Effect.sync(() => {
      state.refreshes++;
    }),
    openUrl: (url) =>
      Effect.gen(function* () {
        opened.push(url);
        if (input.browserFailure)
          return yield* Effect.fail(new LoginFixtureFailure({ message: authUrl }));
      }),
  });
  const login = yield* input.ownerScope ? Scope.provide(input.ownerScope)(controller) : controller;
  return {
    ...login,
    complete,
    calls,
    opened,
    state,
    released,
    startEntered,
    startGate,
    terminate: () => terminate,
  };
});

describe("Codex device-code sign-in", () => {
  it.effect(
    "rechecks rejected credentials after the final awaited daemon admission before logout",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ authenticated: true, requiresReauthentication: true });
        let reads = 0;
        const guard = Effect.sync(() => {
          reads++;
          if (reads === 2) f.state.requiresReauthentication = false;
          return false;
        });
        expect(
          yield* f.loginDeviceCode(guard).pipe(Stream.take(1), Stream.runCollect, Effect.flip),
        ).toMatchObject({ issue: CODEX_LOGIN_ERRORS.account });
        expect(reads).toBe(2);
        expect(f.calls.map((call) => call.method)).toEqual(["account/read"]);
        expect(f.state.refreshes).toBe(0);
      }),
  );
  it.effect("retires the subscriber when its exact provider instance closes", () =>
    Effect.gen(function* () {
      const owner = yield* Scope.make();
      yield* Effect.addFinalizer((exit) => Scope.close(owner, exit));
      const f = yield* fixture({ ownerScope: owner });
      const a = yield* attempt(f);
      yield* Deferred.await(a.shown);
      yield* Scope.close(owner, Exit.void);
      expect(yield* Fiber.join(a.fiber).pipe(Effect.flip)).toMatchObject({
        issue: CODEX_LOGIN_ERRORS.start,
      });
      expect(yield* Deferred.isDone(f.released)).toBe(true);
      expect(f.calls.at(-1)).toEqual({ method: "account/login/cancel", params: { loginId } });
      expect(f.state.refreshes).toBe(0);
    }),
  );

  it.effect("refuses a controller whose instance retired before stream admission", () =>
    Effect.gen(function* () {
      const owner = yield* Scope.make();
      yield* Effect.addFinalizer((exit) => Scope.close(owner, exit));
      const f = yield* fixture({ ownerScope: owner });
      yield* Scope.close(owner, Exit.void);
      expect(
        yield* f.loginDeviceCode(Effect.succeed(false)).pipe(Stream.runCollect, Effect.flip),
      ).toMatchObject({ issue: CODEX_LOGIN_ERRORS.start });
      expect(f.calls).toEqual([]);
    }),
  );
  it.effect("bounds native initialization and joins cleanup before releasing its reservation", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const retired = yield* Deferred.make<void>();
      const controller = yield* makeCodexLogin({
        supportsDeviceCode: () => true,
        withClient: () =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() => Deferred.succeed(retired, undefined));
            yield* Deferred.succeed(entered, undefined);
            return yield* Effect.never;
          }),
        hasSessions: Effect.succeed(false),
        refresh: Effect.void,
        openUrl: () => Effect.void,
      });
      const fiber = yield* controller
        .loginDeviceCode(Effect.succeed(false))
        .pipe(Stream.runCollect, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust(60_000);
      expect(yield* Fiber.join(fiber).pipe(Effect.flip)).toMatchObject({
        issue: CODEX_LOGIN_ERRORS.start,
      });
      expect(yield* Deferred.isDone(retired)).toBe(true);
    }),
  );
  const attempt = Effect.fn("deviceLogin.test.attempt")(function* (
    f: Effect.Success<ReturnType<typeof fixture>>,
  ) {
    const shown = yield* Deferred.make<void>();
    const events: ServerProviderDeviceLoginEvent[] = [];
    const fiber = yield* f.loginDeviceCode(Effect.succeed(false)).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "device-code") yield* Deferred.succeed(shown, undefined);
        }),
      ),
      Effect.forkChild,
    );
    return { fiber, shown, events };
  });

  it.effect(
    "emits private instructions and refreshes only the exact successful native attempt",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const a = yield* attempt(f);
        yield* Deferred.await(a.shown);
        expect(a.events).toEqual([
          {
            type: "device-code",
            verificationUrl: "https://auth.openai.com/codex/device",
            userCode: "ABCD-12345",
          },
        ]);
        expect(f.opened).toEqual([]);
        expect(f.calls).toContainEqual({
          method: "account/login/start",
          params: { type: "chatgptDeviceCode" },
        });
        expect(yield* f.login().pipe(Effect.flip)).toMatchObject({
          issue: CODEX_LOGIN_ERRORS.pending,
        });
        yield* f.complete("unrelated");
        expect(f.state.refreshes).toBe(0);
        yield* f.complete(loginId);
        yield* Fiber.join(a.fiber);
        expect(a.events.at(-1)).toEqual({ type: "authenticated" });
        expect(f.state.refreshes).toBe(1);
        expect(yield* Deferred.isDone(f.released)).toBe(true);
        expect(f.calls.some((call) => call.method === "account/login/cancel")).toBe(false);
      }),
  );

  it.effect("cancels the exact native login and joins its child when the subscriber closes", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const a = yield* attempt(f);
      yield* Deferred.await(a.shown);
      yield* Fiber.interrupt(a.fiber);
      expect(yield* Deferred.isDone(f.released)).toBe(true);
      expect(f.calls.at(-1)).toEqual({ method: "account/login/cancel", params: { loginId } });
      expect(f.state.refreshes).toBe(0);
      expect(yield* f.login()).toBe("started");
    }),
  );

  for (const earlyCompletion of [false, true])
    it.effect(`accepts matching native completion with early=${earlyCompletion}`, () =>
      Effect.gen(function* () {
        const f = yield* fixture({ earlyCompletion });
        const a = yield* attempt(f);
        yield* Deferred.await(a.shown);
        if (!earlyCompletion) yield* f.complete(loginId);
        yield* Fiber.join(a.fiber);
        expect(a.events.map((event) => event.type)).toEqual(["device-code", "authenticated"]);
      }),
    );

  for (const failure of ["rejected", "timeout", "exit"] as const)
    it.effect(`retires a ${failure} attempt without publishing native error text`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const a = yield* attempt(f);
        yield* Deferred.await(a.shown);
        if (failure === "rejected") yield* f.complete(loginId, false);
        if (failure === "timeout") yield* TestClock.adjust(10 * 60_000);
        if (failure === "exit") yield* f.terminate();
        expect(yield* Fiber.join(a.fiber).pipe(Effect.flip)).toMatchObject({
          issue:
            CODEX_LOGIN_ERRORS[
              failure === "rejected" ? "failed" : failure === "exit" ? "start" : "timeout"
            ],
        });
        expect(f.state.refreshes).toBe(0);
        expect(f.calls.at(-1)).toEqual({ method: "account/login/cancel", params: { loginId } });
        expect(yield* Deferred.isDone(f.released)).toBe(true);
      }),
    );

  for (const input of [
    { busy: true },
    { unsupported: true },
    { deviceUrl: "https://example.com/private" },
    { userCode: "private-token?" },
  ])
    it.effect(`refuses inadmissible device login ${Object.keys(input)[0]}`, () =>
      Effect.gen(function* () {
        const f = yield* fixture(input);
        const result = yield* f
          .loginDeviceCode(Effect.succeed(false))
          .pipe(Stream.runCollect, Effect.flip);
        expect(result).toBeInstanceOf(ProviderAdapterValidationError);
        expect(f.state.refreshes).toBe(0);
        expect(f.opened).toEqual([]);
        if ("busy" in input || "unsupported" in input)
          expect(f.calls.some((call) => call.method === "account/login/start")).toBe(false);
      }),
    );

  it.effect(
    "refuses actual daemon sessions and unavailable admission before native credential changes",
    () =>
      Effect.gen(function* () {
        for (const guard of [Effect.succeed(true), Effect.fail("private inventory failure")]) {
          const f = yield* fixture({ authenticated: true, requiresReauthentication: true });
          yield* f.loginDeviceCode(guard).pipe(Stream.runCollect, Effect.flip);
          expect(f.calls.map((call) => call.method)).toEqual(["account/read"]);
        }
      }),
  );

  it.effect("replaces a rejected cached login through the explicit idle device flow", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ authenticated: true, requiresReauthentication: true });
      const a = yield* attempt(f);
      yield* Deferred.await(a.shown);
      expect(f.calls.map((call) => call.method)).toEqual([
        "account/read",
        "account/logout",
        "account/login/start",
      ]);
      yield* f.complete(loginId);
      yield* Fiber.join(a.fiber);
      expect(f.state.refreshes).toBe(1);
    }),
  );

  it.effect("refreshes an already authenticated account without generating a code", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ authenticated: true });
      expect(yield* f.loginDeviceCode(Effect.succeed(false)).pipe(Stream.runCollect)).toEqual([
        { type: "authenticated" },
      ]);
      expect(f.calls.map((call) => call.method)).toEqual(["account/read"]);
    }),
  );

  it("admits only qualified native versions and official bounded instructions", () => {
    for (const version of [undefined, null, "", "garbage", "0.159.9", "0.160.0-alpha.1"])
      expect(supportsCodexDeviceCodeLogin(version)).toBe(false);
    for (const version of ["0.160.0", "0.162.1"])
      expect(supportsCodexDeviceCodeLogin(version)).toBe(true);
    for (const url of [
      "http://auth.openai.com/codex/device",
      "https://auth.openai.com/codex/device?token=private",
      "https://auth.openai.com/codex/device#private",
      "https://auth.openai.com.evil.test/codex/device",
    ])
      expect(codexDeviceLoginInstructions(url, "ABCD-1234")).toBeNull();
    for (const code of ["ABCD-1234", "ABCD-12345"])
      expect(codexDeviceLoginInstructions("https://auth.openai.com/codex/device", code)?.type).toBe(
        "device-code",
      );
    expect(
      codexDeviceLoginInstructions("https://auth.openai.com/codex/device", "A".repeat(4096)),
    ).toBeNull();
  });
});

describe("Codex browser sign-in", () => {
  it.effect("rechecks rejection after awaited session admission before native logout", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ authenticated: true, requiresReauthentication: true });
      const result = yield* f
        .login(
          Effect.sync(() => {
            f.state.requiresReauthentication = false;
            return false;
          }),
        )
        .pipe(Effect.flip);
      expect(result).toMatchObject({ issue: CODEX_LOGIN_ERRORS.account });
      yield* Deferred.await(f.released);
      expect(f.calls.map((call) => call.method)).toEqual(["account/read"]);
    }),
  );
  it.effect("replaces a confirmed revoked login despite cached account metadata", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ authenticated: true, requiresReauthentication: true });
      expect(yield* f.login()).toBe("started");
      expect(f.calls.map((call) => call.method)).toEqual([
        "account/read",
        "account/logout",
        "account/login/start",
      ]);
      expect(f.state.refreshes).toBe(0);
      yield* f.complete(loginId);
      yield* Deferred.await(f.released);
      expect(f.state.refreshes).toBe(1);
    }),
  );

  it.effect("never logs out a rejected account while its Cafe session is open", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ authenticated: true, requiresReauthentication: true, busy: true });
      expect(yield* f.login().pipe(Effect.flip)).toMatchObject({ issue: CODEX_LOGIN_ERRORS.busy });
      yield* Deferred.await(f.released);
      expect(f.calls.map((call) => call.method)).toEqual(["account/read"]);
      expect(f.opened).toEqual([]);
    }),
  );
  it.effect("checks actual daemon sessions before starting native login", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      expect(yield* f.login(Effect.succeed(true)).pipe(Effect.flip)).toMatchObject({
        issue: CODEX_LOGIN_ERRORS.busy,
      });
      expect(f.calls.map((call) => call.method)).toEqual(["account/read"]);
      expect(f.opened).toEqual([]);
    }),
  );
  it.effect("fails closed when the actual daemon session inventory is unavailable", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      expect(
        yield* f.login(Effect.die(new Error("private fixture failure"))).pipe(Effect.flip),
      ).toMatchObject({ issue: CODEX_LOGIN_ERRORS.start });
      expect(f.calls.map((call) => call.method)).toEqual(["account/read"]);
      expect(f.opened).toEqual([]);
    }),
  );
  it.effect("bounds connection startup and joins its cleanup before returning a safe failure", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      const login = yield* makeCodexLogin({
        withClient: () =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() => Deferred.succeed(released, undefined));
            yield* Deferred.succeed(entered, undefined);
            return yield* Effect.never;
          }),
        hasSessions: Effect.succeed(false),
        refresh: Effect.die("Startup cannot refresh an account"),
        openUrl: () => Effect.die("Startup cannot open a browser"),
      });
      const fiber = yield* Effect.forkChild(login.login());
      yield* Deferred.await(entered);
      yield* TestClock.adjust(60_000);
      expect(yield* Fiber.join(fiber).pipe(Effect.flip)).toMatchObject({
        issue: CODEX_LOGIN_ERRORS.start,
      });
      expect(yield* Deferred.isDone(released)).toBe(true);
    }),
  );
  it.effect("retires a native connection that exits while awaiting browser completion", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.login();
      yield* f.terminate();
      yield* Deferred.await(f.released);
      expect(f.state.refreshes).toBe(0);
      expect(f.calls.at(-1)).toEqual({ method: "account/login/cancel", params: { loginId } });
    }),
  );
  it.effect("opens one native attempt and refreshes only its exact successful completion", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      expect(yield* f.login()).toBe("started");
      expect(f.opened).toEqual([authUrl]);
      expect(f.calls).toEqual([
        { method: "account/read", params: {} },
        { method: "account/login/start", params: { type: "chatgpt" } },
      ]);
      expect(f.state.refreshes).toBe(0);
      expect(yield* f.login().pipe(Effect.flip)).toMatchObject({
        issue: CODEX_LOGIN_ERRORS.pending,
      });
      yield* f.complete("other-login");
      yield* f.complete(null);
      yield* f.complete(undefined);
      expect(f.state.refreshes).toBe(0);
      expect(yield* Deferred.isDone(f.released)).toBe(false);
      yield* f.complete(loginId);
      yield* Deferred.await(f.released);
      expect(f.state.refreshes).toBe(1);
      expect(f.calls.map((call) => call.method)).not.toContain("account/login/cancel");
    }),
  );

  it.effect("retains a completion received before the start response", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ earlyCompletion: true });
      expect(yield* f.login()).toBe("started");
      yield* Deferred.await(f.released);
      expect(f.state.refreshes).toBe(1);
    }),
  );

  it.effect(
    "refreshes an already authenticated account without changing credentials or opening a browser",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ authenticated: true, busy: true });
        expect(yield* f.login()).toBe("authenticated");
        yield* Deferred.await(f.released);
        expect(f.state.refreshes).toBe(1);
        expect(f.opened).toEqual([]);
        expect(f.calls.map((call) => call.method)).toEqual(["account/read"]);
      }),
  );

  it.effect("refuses to change sign-in while this account owns a Cafe session", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ busy: true });
      expect(yield* f.login().pipe(Effect.flip)).toMatchObject({ issue: CODEX_LOGIN_ERRORS.busy });
      yield* Deferred.await(f.released);
      expect(f.opened).toEqual([]);
      expect(f.calls.map((call) => call.method)).toEqual(["account/read"]);
    }),
  );

  for (const scenario of ["url", "browser", "start"] as const) {
    it.effect(`sanitizes ${scenario} failures and cancels an admitted attempt`, () =>
      Effect.gen(function* () {
        const f = yield* fixture({
          url: scenario === "url" ? "https://untrusted.example/?secret=private" : authUrl,
          browserFailure: scenario === "browser",
          startFailure: scenario === "start",
        });
        const error = yield* f.login().pipe(Effect.flip);
        expect(error.issue).toBe(CODEX_LOGIN_ERRORS[scenario]);
        expect(encodeProviderJsonString(error)).not.toContain("private");
        yield* Deferred.await(f.released);
        expect(f.state.refreshes).toBe(0);
        expect(f.calls.filter((call) => call.method === "account/login/cancel")).toEqual(
          scenario === "start" ? [] : [{ method: "account/login/cancel", params: { loginId } }],
        );
        if (scenario !== "browser") expect(f.opened).toEqual([]);
      }),
    );
  }

  it.effect("cancels and releases a failed native completion without claiming authentication", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.login();
      yield* f.complete(loginId, false);
      yield* Deferred.await(f.released);
      expect(f.state.refreshes).toBe(0);
      expect(f.calls.at(-1)).toEqual({ method: "account/login/cancel", params: { loginId } });
    }),
  );

  it.effect("retires the owned attempt and connection when its instance closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const f = yield* fixture().pipe(Effect.provideService(Scope.Scope, scope));
      yield* f.login();
      yield* Scope.close(scope, Exit.void);
      expect(yield* Deferred.isDone(f.released)).toBe(true);
      expect(f.state.refreshes).toBe(0);
      expect(f.calls.at(-1)).toEqual({ method: "account/login/cancel", params: { loginId } });
    }),
  );

  it.effect(
    "joins startup cleanup when the requesting action is cancelled before acknowledgement",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ holdStart: true });
        const fiber = yield* Effect.forkChild(f.login());
        yield* Deferred.await(f.startEntered);
        yield* Fiber.interrupt(fiber);
        expect(yield* Deferred.isDone(f.released)).toBe(true);
        expect(f.opened).toEqual([]);
        expect(f.state.refreshes).toBe(0);
      }),
  );

  it.effect("expires an unfinished attempt under its fixed completion budget", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.login();
      yield* TestClock.adjust(10 * 60_000);
      yield* Deferred.await(f.released);
      expect(f.state.refreshes).toBe(0);
      expect(f.calls.at(-1)).toEqual({ method: "account/login/cancel", params: { loginId } });
    }),
  );
});

describe("Codex login public boundary", () => {
  it("admits bounded official HTTPS authorization origins only", () => {
    expect(codexLoginUrl(authUrl)).toBe(authUrl);
    expect(codexLoginUrl(authUrl.replace("auth.openai.com", "chatgpt.com"))).toContain(
      "https://chatgpt.com/",
    );
    for (const url of [
      "javascript:alert(1)",
      authUrl.replace("https:", "http:"),
      authUrl.replace("auth.openai.com", "auth.openai.com.evil.example"),
      authUrl.replace("auth.openai.com", "user@auth.openai.com"),
      authUrl.replace("auth.openai.com", "auth.openai.com:444"),
      `${authUrl}#private`,
      `${authUrl}\n`,
      `https://auth.openai.com/${"x".repeat(4096)}`,
    ])
      expect(codexLoginUrl(url)).toBeNull();
  });
  it("exposes finite Cafe messages and discards native errors and URLs", () => {
    for (const issue of Object.values(CODEX_LOGIN_ERRORS))
      expect(
        codexLoginFailureMessage(
          new ProviderAdapterValidationError({ provider: "codex", operation: "login", issue }),
        ),
      ).toBe(issue);
    expect(codexLoginFailureMessage(new Error(authUrl))).toBe(CODEX_LOGIN_ERRORS.start);
    expect(
      codexLoginFailureMessage(
        new ProviderAdapterValidationError({
          provider: "codex",
          operation: "login",
          issue: authUrl,
        }),
      ),
    ).toBe(CODEX_LOGIN_ERRORS.start);
  });
});
