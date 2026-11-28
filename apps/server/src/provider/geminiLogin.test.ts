import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { ServerProviderDeviceLoginEvent } from "@cafecode/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  GEMINI_LOGIN_ERRORS,
  geminiLoginFailureMessage,
  geminiOAuthAuthorizationUrl,
  geminiVerificationUrl,
  geminiVerificationUrlFromJsonRpcLine,
  makeGeminiLogin,
  normalizeSubmittedGeminiLoginCode,
} from "./geminiLogin.ts";

const VALID_OAUTH_URL =
  "https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=test-client.apps.googleusercontent.com&code_challenge=abc123&code_challenge_method=S256&prompt=consent&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&scope=openid&state=opaque-state";

const VALID_VERIFICATION_URL =
  "https://accounts.google.com/v3/signin/challenge/verify?continue=https%3A%2F%2Fantigravity.google";

function makeFixtureSpawner(
  native: ChildProcessSpawner.ChildProcessSpawner["Service"],
  script: string,
) {
  return ChildProcessSpawner.make((command) => {
    if (command._tag !== "StandardCommand" || command.command !== process.execPath) {
      return native.spawn(command);
    }
    return native.spawn(
      ChildProcess.make(process.execPath, ["-e", script, ...command.args], {
        ...command.options,
        env: {
          ...command.options.env,
          CAFE_TEST_OAUTH_URL: VALID_OAUTH_URL,
          CAFE_TEST_VERIFICATION_URL: VALID_VERIFICATION_URL,
        },
      }),
    );
  });
}

describe("gemini headless login helpers", () => {
  it("validates Google OAuth links and rejects unsafe or mismatched targets", () => {
    expect(geminiOAuthAuthorizationUrl(`Open:\n  ${VALID_OAUTH_URL}\n`)).toBe(VALID_OAUTH_URL);
    expect(geminiOAuthAuthorizationUrl(VALID_OAUTH_URL, { requireTerminator: true })).toBeNull();
    expect(geminiOAuthAuthorizationUrl(`${VALID_OAUTH_URL}\n`, { requireTerminator: true })).toBe(
      VALID_OAUTH_URL,
    );
    expect(
      geminiOAuthAuthorizationUrl(
        "https://evil.example/o/oauth2/auth?client_id=x&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code",
      ),
    ).toBeNull();
    expect(
      geminiOAuthAuthorizationUrl(
        "https://accounts.google.com/o/oauth2/auth?client_id=x&redirect_uri=https%3A%2F%2Fevil.example%2Fcb&response_type=code",
      ),
    ).toBeNull();
    expect(geminiOAuthAuthorizationUrl(`${VALID_OAUTH_URL}#fragment`)).toBeNull();
  });

  it("extracts allowlisted verification links while ignoring OAuth links and untrusted hosts", () => {
    expect(
      geminiVerificationUrl(
        `Open ${VALID_OAUTH_URL}\nVerify your account to continue: ${VALID_VERIFICATION_URL}.`,
      ),
    ).toBe(VALID_VERIFICATION_URL);
    expect(
      geminiVerificationUrl(
        "See https://support.google.com/accounts/answer/40695 for account appeal.",
      ),
    ).toBe("https://support.google.com/accounts/answer/40695");
    expect(geminiVerificationUrl("Visit https://evil.example/verify")).toBeNull();
    expect(geminiVerificationUrl("https://antigravity.google/oauth-callback?code=abc")).toBeNull();
  });

  it("extracts verification links from ACP JSON-RPC error lines", () => {
    const fromMessage = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      error: {
        code: -32000,
        message: `Verify your account to continue. ${VALID_VERIFICATION_URL}`,
      },
    });
    expect(geminiVerificationUrlFromJsonRpcLine(fromMessage)).toBe(VALID_VERIFICATION_URL);

    const fromData = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      error: {
        code: -32000,
        message: "Verify your account to continue.",
        data: { details: { verificationUrl: "https://myaccount.google.com/age-verification" } },
      },
    });
    expect(geminiVerificationUrlFromJsonRpcLine(fromData)).toBe(
      "https://myaccount.google.com/age-verification",
    );
    expect(
      geminiVerificationUrlFromJsonRpcLine(
        JSON.stringify({ jsonrpc: "2.0", id: 2, result: { url: VALID_VERIFICATION_URL } }),
      ),
    ).toBeNull();
  });

  it("normalizes pasted codes and refuses control characters or empty input", () => {
    expect(normalizeSubmittedGeminiLoginCode("  4/0AfJohX-valid-code  ")).toBe(
      "4/0AfJohX-valid-code",
    );
    expect(
      normalizeSubmittedGeminiLoginCode("https://antigravity.google/oauth-callback?code=abc"),
    ).toBe("https://antigravity.google/oauth-callback?code=abc");
    expect(normalizeSubmittedGeminiLoginCode("   ")).toBeNull();
    expect(normalizeSubmittedGeminiLoginCode("abc\ndef")).toBeNull();
    expect(normalizeSubmittedGeminiLoginCode("abc\rdef")).toBeNull();
    expect(normalizeSubmittedGeminiLoginCode("x".repeat(5000))).toBeNull();
  });
});

describe("makeGeminiLogin", () => {
  it.live(
    "streams an OAuth link split across chunks, delivers submitted code, and authenticates",
    () =>
      Effect.gen(function* () {
        const native = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fs = yield* FileSystem.FileSystem;
        let refreshedCount = 0;
        const script = `
        const { createInterface } = require("node:readline");
        const url = process.env.CAFE_TEST_OAUTH_URL;
        const split = Math.floor(url.length / 2);
        process.stdout.write("Open this link:\\n\\n  " + url.slice(0, split));
        setTimeout(() => {
          process.stdout.write(url.slice(split) + "\\n\\nThen paste the code:\\n");
        }, 25);
        createInterface({ input: process.stdin }).once("line", (line) => {
          if (line.trim() === "4/0A-fixture-code") {
            console.log("Logged in.");
            process.exit(0);
          }
          console.error("couldn't log in: invalid_grant");
          process.exit(1);
        });
      `;
        const login = yield* makeGeminiLogin({
          qualifyCli: () => Effect.succeed({ binaryPath: process.execPath }),
          environment: {},
          spawner: makeFixtureSpawner(native, script),
          fs,
          hasSessions: Effect.succeed(false),
          refresh: Effect.sync(() => {
            refreshedCount++;
            return { authenticated: true, verificationUrl: null };
          }),
        });

        const events: ServerProviderDeviceLoginEvent[] = [];
        const gotOAuth = yield* Deferred.make<{ loginId: string; authorizationUrl: string }>();
        const fiber = yield* login.loginDeviceCode(Effect.succeed(false)).pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              events.push(event);
              if (event.type === "oauth-code") {
                yield* Deferred.succeed(gotOAuth, {
                  loginId: event.loginId,
                  authorizationUrl: event.authorizationUrl,
                });
              }
            }),
          ),
          Effect.forkChild,
        );

        const oauth = yield* Deferred.await(gotOAuth);
        expect(oauth.authorizationUrl).toBe(VALID_OAUTH_URL);

        // Unknown loginId must be rejected without disturbing the pending login.
        const wrongIdError = yield* login
          .submitLoginCode({ loginId: "wrong-id", code: "4/0A-fixture-code" })
          .pipe(Effect.flip);
        expect(geminiLoginFailureMessage(wrongIdError)).toBe(GEMINI_LOGIN_ERRORS.expired);

        yield* login.submitLoginCode({ loginId: oauth.loginId, code: " 4/0A-fixture-code " });

        // Submitting a second time must be rejected.
        const replayError = yield* login
          .submitLoginCode({ loginId: oauth.loginId, code: "4/0A-fixture-code" })
          .pipe(Effect.flip);
        expect(geminiLoginFailureMessage(replayError)).toBe(GEMINI_LOGIN_ERRORS.expired);

        yield* Fiber.join(fiber);
        expect(refreshedCount).toBe(1);
        expect(events).toEqual([
          { type: "oauth-code", loginId: oauth.loginId, authorizationUrl: VALID_OAUTH_URL },
          { type: "authenticated" },
        ]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("emits verification-required when CLI output contains a Google verification link", () =>
    Effect.gen(function* () {
      const native = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      const script = `
        const { createInterface } = require("node:readline");
        process.stdout.write("Open:\\n  " + process.env.CAFE_TEST_OAUTH_URL + "\\n");
        createInterface({ input: process.stdin }).once("line", () => {
          console.error("Verify your account to continue. " + process.env.CAFE_TEST_VERIFICATION_URL);
          process.exit(1);
        });
      `;
      const login = yield* makeGeminiLogin({
        qualifyCli: () => Effect.succeed({ binaryPath: process.execPath }),
        environment: {},
        spawner: makeFixtureSpawner(native, script),
        fs,
        hasSessions: Effect.succeed(false),
        refresh: Effect.succeed({ authenticated: false, verificationUrl: null }),
      });

      const events: ServerProviderDeviceLoginEvent[] = [];
      const gotOAuth = yield* Deferred.make<string>();
      const fiber = yield* login.loginDeviceCode(Effect.succeed(false)).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            events.push(event);
            if (event.type === "oauth-code") yield* Deferred.succeed(gotOAuth, event.loginId);
          }),
        ),
        Effect.forkChild,
      );

      const loginId = yield* Deferred.await(gotOAuth);
      yield* login.submitLoginCode({ loginId, code: "4/0A-fixture-code" });
      yield* Fiber.join(fiber);

      expect(events).toEqual([
        { type: "oauth-code", loginId, authorizationUrl: VALID_OAUTH_URL },
        { type: "verification-required", verificationUrl: VALID_VERIFICATION_URL },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "emits verification-required when post-login refresh detects verification requirement",
    () =>
      Effect.gen(function* () {
        const native = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fs = yield* FileSystem.FileSystem;
        const script = `
        const { createInterface } = require("node:readline");
        process.stdout.write("Open:\\n  " + process.env.CAFE_TEST_OAUTH_URL + "\\n");
        createInterface({ input: process.stdin }).once("line", () => {
          process.exit(0);
        });
      `;
        const login = yield* makeGeminiLogin({
          qualifyCli: () => Effect.succeed({ binaryPath: process.execPath }),
          environment: {},
          spawner: makeFixtureSpawner(native, script),
          fs,
          hasSessions: Effect.succeed(false),
          refresh: Effect.succeed({
            authenticated: false,
            verificationUrl: VALID_VERIFICATION_URL,
          }),
        });

        const events: ServerProviderDeviceLoginEvent[] = [];
        const gotOAuth = yield* Deferred.make<string>();
        const fiber = yield* login.loginDeviceCode(Effect.succeed(false)).pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              events.push(event);
              if (event.type === "oauth-code") yield* Deferred.succeed(gotOAuth, event.loginId);
            }),
          ),
          Effect.forkChild,
        );

        const loginId = yield* Deferred.await(gotOAuth);
        yield* login.submitLoginCode({ loginId, code: "4/0A-fixture-code" });
        yield* Fiber.join(fiber);

        expect(events).toEqual([
          { type: "oauth-code", loginId, authorizationUrl: VALID_OAUTH_URL },
          { type: "verification-required", verificationUrl: VALID_VERIFICATION_URL },
        ]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("refuses login when sessions are active and enforces single-flight pending lock", () =>
    Effect.gen(function* () {
      const native = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      const script = `
        const { createInterface } = require("node:readline");
        process.stdout.write("Open:\\n  " + process.env.CAFE_TEST_OAUTH_URL + "\\n");
        createInterface({ input: process.stdin }).once("line", () => process.exit(0));
      `;
      const login = yield* makeGeminiLogin({
        qualifyCli: () => Effect.succeed({ binaryPath: process.execPath }),
        environment: {},
        spawner: makeFixtureSpawner(native, script),
        fs,
        hasSessions: Effect.succeed(false),
        refresh: Effect.succeed({ authenticated: true, verificationUrl: null }),
      });

      const busyError = yield* login
        .loginDeviceCode(Effect.succeed(true))
        .pipe(Stream.runCollect, Effect.flip);
      expect(geminiLoginFailureMessage(busyError)).toBe(GEMINI_LOGIN_ERRORS.busy);

      const gotOAuth = yield* Deferred.make<string>();
      const fiber = yield* login.loginDeviceCode(Effect.succeed(false)).pipe(
        Stream.runForEach((event) =>
          event.type === "oauth-code" ? Deferred.succeed(gotOAuth, event.loginId) : Effect.void,
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(gotOAuth);

      const concurrentError = yield* login
        .loginDeviceCode(Effect.succeed(false))
        .pipe(Stream.runCollect, Effect.flip);
      expect(geminiLoginFailureMessage(concurrentError)).toBe(GEMINI_LOGIN_ERRORS.pending);

      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "shortcuts directly to a fresh verification link without OAuth when verification is pending, unless forceLogin is set",
    () =>
      Effect.gen(function* () {
        const native = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fs = yield* FileSystem.FileSystem;
        let spawnedLogin = 0;
        const script = `
          const { createInterface } = require("node:readline");
          process.stdout.write("Open:\\n  " + process.env.CAFE_TEST_OAUTH_URL + "\\n");
          createInterface({ input: process.stdin }).once("line", () => process.exit(0));
        `;
        const spawner = ChildProcessSpawner.make((command) => {
          if (command._tag === "StandardCommand" && command.command === process.execPath) {
            spawnedLogin++;
          }
          return makeFixtureSpawner(native, script).spawn(command);
        });
        let verificationPending = true;
        const login = yield* makeGeminiLogin({
          qualifyCli: () => Effect.succeed({ binaryPath: process.execPath }),
          environment: {},
          spawner,
          fs,
          hasSessions: Effect.succeed(true),
          hasVerificationRequired: () => verificationPending,
          refresh: Effect.sync(() => ({
            authenticated: !verificationPending,
            verificationUrl: verificationPending ? VALID_VERIFICATION_URL : null,
          })),
        });

        // Even with active sessions, direct verification refresh does not spawn --login.
        const directEvents: ServerProviderDeviceLoginEvent[] = [];
        yield* login.loginDeviceCode(Effect.succeed(true)).pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              directEvents.push(event);
            }),
          ),
        );
        expect(spawnedLogin).toBe(0);
        expect(directEvents).toEqual([
          { type: "verification-required", verificationUrl: VALID_VERIFICATION_URL },
        ]);

        // forceLogin enforces idle sessions before starting OAuth account switch.
        const busyError = yield* login
          .loginDeviceCode(Effect.succeed(true), { forceLogin: true })
          .pipe(Stream.runCollect, Effect.flip);
        expect(geminiLoginFailureMessage(busyError)).toBe(GEMINI_LOGIN_ERRORS.busy);
        expect(spawnedLogin).toBe(0);

        // Once verified, direct check emits authenticated without spawning --login.
        verificationPending = false;
        const authedLogin = yield* makeGeminiLogin({
          qualifyCli: () => Effect.succeed({ binaryPath: process.execPath }),
          environment: {},
          spawner,
          fs,
          hasSessions: Effect.succeed(false),
          hasVerificationRequired: () => true,
          refresh: Effect.succeed({ authenticated: true, verificationUrl: null }),
        });
        const authedEvents: ServerProviderDeviceLoginEvent[] = [];
        yield* authedLogin.loginDeviceCode(Effect.succeed(false)).pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              authedEvents.push(event);
            }),
          ),
        );
        expect(spawnedLogin).toBe(0);
        expect(authedEvents).toEqual([{ type: "authenticated" }]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
