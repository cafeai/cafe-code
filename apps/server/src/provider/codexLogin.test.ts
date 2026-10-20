import * as ProviderJsonSchema from "effect/Schema";
import * as Data from "effect/Data";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as TestClock from "effect/testing/TestClock";
import type * as CodexClient from "effect-codex-app-server/client";
import { ProviderAdapterValidationError } from "./Errors.ts";
import {
  CODEX_LOGIN_ERRORS,
  codexLoginFailureMessage,
  codexLoginUrl,
  makeCodexLogin,
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
    readonly busy?: boolean;
    readonly url?: string;
    readonly browserFailure?: boolean;
    readonly startFailure?: boolean;
    readonly earlyCompletion?: boolean;
    readonly holdStart?: boolean;
  } = {},
) {
  const released = yield* Deferred.make<void>();
  const startEntered = yield* Deferred.make<void>();
  const startGate = yield* Deferred.make<void>();
  const calls: { method: string; params: unknown }[] = [];
  const opened: string[] = [];
  const state = { refreshes: 0 };
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
          return { type: "chatgpt", loginId, authUrl: input.url ?? authUrl };
        }
        if (method === "account/login/cancel") return {};
        return yield* Effect.die(new Error(`Unexpected method ${method}`));
      }),
  } as unknown as CodexClient.CodexAppServerClientShape;
  const login = yield* makeCodexLogin({
    withClient: (use, onTermination) =>
      Effect.gen(function* () {
        terminate = onTermination;
        yield* Effect.addFinalizer(() => Deferred.succeed(released, undefined));
        yield* use(client);
      }),
    hasSessions: Effect.succeed(input.busy ?? false),
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
  return {
    login,
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

describe("Codex browser sign-in", () => {
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
      const fiber = yield* Effect.forkChild(login());
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
