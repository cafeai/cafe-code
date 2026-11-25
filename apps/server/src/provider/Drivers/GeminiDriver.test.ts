// @effect-diagnostics nodeBuiltinImport:off
import { fileURLToPath } from "node:url";

import {
  ProviderInstanceId,
  ThreadId,
  type ServerProviderDeviceLoginEvent,
} from "@cafecode/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { GeminiDriver } from "./GeminiDriver.ts";

const configLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "cafecode-gemini-driver-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));
const fixture = fileURLToPath(new URL("../testUtils/geminiAcpFixture.cjs", import.meta.url));

it.live(
  "uses its admitted private home for every Gemini command and refuses a foreign resume",
  () =>
    Effect.gen(function* () {
      const native = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      const { cwd } = yield* ServerConfig;
      const nativeHome = yield* fs.makeTempDirectoryScoped({
        prefix: "cafe-gemini-private-fixture-",
      });
      const launches: Array<{ args: ReadonlyArray<string>; forceFile: string | undefined }> = [];
      let version = "1.5.15";
      const spawner = ChildProcessSpawner.make((command) => {
        if (command._tag !== "StandardCommand" || command.command !== process.execPath) {
          return native.spawn(command);
        }
        if (!command.args.includes("--version")) {
          launches.push({
            args: command.args,
            forceFile: command.options.env?.AGY_CLI_FORCE_FILE_TOKEN_STORAGE,
          });
        }
        return native.spawn(
          ChildProcess.make(command.command, [fixture, ...command.args], {
            ...command.options,
            env: { ...command.options.env, CAFE_GEMINI_FIXTURE_NATIVE_VERSION: version },
          }),
        );
      });
      const instanceId = ProviderInstanceId.make("private-gemini");
      const instance = yield* GeminiDriver.create({
        instanceId,
        displayName: undefined,
        nativeHome,
        enabled: true,
        environment: [],
        config: { ...GeminiDriver.defaultConfig(), binaryPath: process.execPath },
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      const unqualified = yield* instance.snapshot.refresh;
      assert.include(unqualified.message ?? "", "Private Antigravity homes require");
      assert.isUndefined(unqualified.authActions);
      assert.deepEqual(launches, []);

      const threadId = ThreadId.make("private-gemini-thread");
      const start = {
        threadId,
        cwd,
        runtimeMode: "full-access",
        modelSelection: { instanceId, model: "gemini-4-neon" },
      } as const;
      const foreignResume = yield* instance.adapter
        .startSession({
          ...start,
          resumeCursor: { version: 1, instanceId, threadId, cwd, sessionId: "unscoped-native-id" },
        })
        .pipe(Effect.flip);
      assert.include(foreignResume.message, "another native provider home");
      assert.deepEqual(launches, []);

      version = "1.5.16";
      const ready = yield* instance.snapshot.refresh;
      if (process.platform !== "darwin" || process.arch !== "arm64") {
        assert.include(ready.message ?? "", "Private Antigravity homes require");
        assert.deepEqual(launches, []);
        return;
      }
      assert.equal(ready.auth.status, "authenticated");
      assert.isDefined(ready.accountRateLimits);
      const gotOAuth = yield* Deferred.make<string>();
      const login = yield* instance.adapter.loginDeviceCode!(Effect.succeed(false)).pipe(
        Stream.runForEach((event) =>
          event.type === "oauth-code" ? Deferred.succeed(gotOAuth, event.loginId) : Effect.void,
        ),
        Effect.forkChild,
      );
      yield* instance.adapter.submitLoginCode!({
        loginId: yield* Deferred.await(gotOAuth),
        code: "valid-code",
      });
      yield* Fiber.join(login);
      const opened = yield* instance.adapter.startSession(start);
      assert.property(opened.resumeCursor, "nativeHomeScope");
      yield* instance.adapter.stopSession(threadId);
      yield* instance.adapter.startSession({ ...start, resumeCursor: opened.resumeCursor });
      yield* instance.adapter.stopSession(threadId);
      assert.isTrue(launches.some(({ args }) => args.includes("--login")));
      assert.isTrue(launches.some(({ args }) => args.includes("--print")));
      for (const { args, forceFile } of launches) {
        const homeIndex = args.indexOf("--gemini_dir");
        assert.isAtLeast(homeIndex, 0);
        assert.equal(args[homeIndex + 1], nativeHome);
        assert.equal(forceFile, "1");
      }
    }).pipe(Effect.provide(configLayer)),
);

it.live("preserves historical Gemini quota until fresh usage or a conclusive sign-in refusal", () =>
  Effect.gen(function* () {
    const native = yield* ChildProcessSpawner.ChildProcessSpawner;
    let ide = false;
    let catalogErrorCode: number | undefined;
    let usageReplyCommand = "usage";
    let remainingFraction = 0.4;
    let startedAcp = 0;
    const spawner = ChildProcessSpawner.make((command) => {
      if (command._tag !== "StandardCommand" || command.command !== process.execPath) {
        return native.spawn(command);
      }
      if (command.args[0] === "acp") startedAcp++;
      const args =
        ide && command.args[0] === "--version"
          ? ["-e", 'console.log("1.107.0\\n3ab42ef\\narm64")']
          : [fixture, ...command.args];
      return native.spawn(
        ChildProcess.make(command.command, args, {
          ...command.options,
          env: {
            ...command.options.env,
            CAFE_GEMINI_FIXTURE_REPLY_COMMAND: usageReplyCommand,
            CAFE_GEMINI_FIXTURE_QUOTA_FRACTION: String(remainingFraction),
            ...(catalogErrorCode === undefined
              ? {}
              : { CAFE_GEMINI_FIXTURE_CATALOG_ERROR_CODE: String(catalogErrorCode) }),
          },
        }),
      );
    });
    const instance = yield* GeminiDriver.create({
      instanceId: ProviderInstanceId.make("test-antigravity"),
      displayName: undefined,
      enabled: true,
      environment: [],
      processEnvironment: { CAFE_GEMINI_FIXTURE_NATIVE_VERSION: "1.5.16" },
      config: { ...GeminiDriver.defaultConfig(), binaryPath: process.execPath },
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

    const ready = yield* instance.snapshot.refresh;
    assert.equal(ready.version, "1.5.16");
    assert.equal(ready.auth.status, "authenticated");
    assert.deepEqual(
      ready.models.map((model) => model.slug),
      ["gemini-4-neon"],
    );
    assert.equal(startedAcp, 1);
    assert.deepEqual(ready.accountRateLimits?.rateLimitsByLimitId, {
      "gemini-5h": {
        limitId: "gemini-5h",
        limitName: "Gemini Models",
        primary: {
          usedPercent: 60,
          windowDurationMins: 300,
          resetsAt: Date.parse("2026-11-21T07:00:00Z") / 1_000,
        },
        secondary: {
          usedPercent: 25,
          windowDurationMins: 10_080,
          resetsAt: Date.parse("2026-11-24T22:16:37Z") / 1_000,
        },
      },
      "3p-5h": {
        limitId: "3p-5h",
        limitName: "Claude and GPT Models",
        primary: {
          usedPercent: 85,
          windowDurationMins: 300,
          resetsAt: Date.parse("2026-11-21T08:00:00Z") / 1_000,
        },
      },
    });

    usageReplyCommand = "stats";
    assert.isDefined(instance.snapshot.refreshAccountUsage);
    const staleQuota = yield* instance.snapshot.refreshAccountUsage!;
    assert.equal(staleQuota.auth.status, "authenticated");
    assert.deepEqual(staleQuota.accountRateLimits, { ...ready.accountRateLimits!, stale: true });
    assert.equal(startedAcp, 1, "an account usage refresh must not open a new ACP session");

    catalogErrorCode = -32603;
    const inconclusiveStatus = yield* instance.snapshot.refresh;
    assert.equal(inconclusiveStatus.auth.status, "unknown");
    assert.deepEqual(inconclusiveStatus.accountRateLimits, staleQuota.accountRateLimits);

    catalogErrorCode = undefined;
    usageReplyCommand = "usage";
    remainingFraction = 0.5;
    const recovered = yield* instance.snapshot.refresh;
    assert.isUndefined(recovered.accountRateLimits?.stale);
    assert.equal(recovered.accountRateLimits?.rateLimits.primary?.usedPercent, 50);

    catalogErrorCode = -32000;
    const signedOut = yield* instance.snapshot.refresh;
    assert.equal(signedOut.auth.status, "unauthenticated");
    assert.isUndefined(signedOut.accountRateLimits);

    catalogErrorCode = undefined;
    usageReplyCommand = "stats";
    const signedInAgain = yield* instance.snapshot.refresh;
    assert.equal(signedInAgain.auth.status, "authenticated");
    assert.isUndefined(signedInAgain.accountRateLimits);

    ide = true;
    const unavailable = yield* instance.snapshot.refresh;
    assert.equal(unavailable.status, "error");
    assert.deepEqual(unavailable.models, []);
    assert.equal(startedAcp, 5);
  }).pipe(Effect.provide(configLayer)),
);

it.live(
  "surfaces Gemini verification-required state without leaking the URL into snapshots and supports headless login",
  () =>
    Effect.gen(function* () {
      const native = yield* ChildProcessSpawner.ChildProcessSpawner;
      const verificationUrl =
        "https://accounts.google.com/v3/signin/challenge/verify?continue=https%3A%2F%2Fantigravity.google";
      let catalogErrorCode: number | undefined = -32000;
      let catalogErrorMessage: string | undefined =
        `Verify your account to continue. ${verificationUrl}`;
      const spawner = ChildProcessSpawner.make((command) => {
        if (command._tag !== "StandardCommand" || command.command !== process.execPath) {
          return native.spawn(command);
        }
        return native.spawn(
          ChildProcess.make(command.command, [fixture, ...command.args], {
            ...command.options,
            env: {
              ...command.options.env,
              ...(catalogErrorCode === undefined
                ? {}
                : { CAFE_GEMINI_FIXTURE_CATALOG_ERROR_CODE: String(catalogErrorCode) }),
              ...(catalogErrorMessage === undefined
                ? {}
                : { CAFE_GEMINI_FIXTURE_CATALOG_ERROR_MESSAGE: catalogErrorMessage }),
            },
          }),
        );
      });
      const instance = yield* GeminiDriver.create({
        instanceId: ProviderInstanceId.make("test-antigravity-login"),
        displayName: undefined,
        enabled: true,
        environment: [],
        processEnvironment: { CAFE_GEMINI_FIXTURE_NATIVE_VERSION: "1.5.16" },
        config: { ...GeminiDriver.defaultConfig(), binaryPath: process.execPath },
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      const needsVerification = yield* instance.snapshot.refresh;
      assert.equal(needsVerification.auth.status, "unauthenticated");
      assert.deepEqual(needsVerification.authActions, { login: true, deviceCodeLogin: true });
      assert.include(needsVerification.message ?? "", "additional verification");
      assert.notInclude(needsVerification.message ?? "", verificationUrl);

      // Run headless login while post-login catalog check still requires verification.
      const events: ServerProviderDeviceLoginEvent[] = [];
      const gotOAuth = yield* Deferred.make<string>();
      const loginFiber = yield* instance.adapter.loginDeviceCode!(Effect.succeed(false)).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            events.push(event);
            if (event.type === "oauth-code") yield* Deferred.succeed(gotOAuth, event.loginId);
          }),
        ),
        Effect.forkChild,
      );
      const loginId = yield* Deferred.await(gotOAuth);
      yield* instance.adapter.submitLoginCode!({ loginId, code: "valid-code" });
      yield* Fiber.join(loginFiber);

      assert.equal(events.length, 2);
      assert.equal(events[0]?.type, "oauth-code");
      assert.deepEqual(events[1], { type: "verification-required", verificationUrl });

      // Once verified, login + refresh completes as authenticated.
      catalogErrorCode = undefined;
      catalogErrorMessage = undefined;
      const verifiedEvents: ServerProviderDeviceLoginEvent[] = [];
      const gotOAuth2 = yield* Deferred.make<string>();
      const loginFiber2 = yield* instance.adapter.loginDeviceCode!(Effect.succeed(false)).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            verifiedEvents.push(event);
            if (event.type === "oauth-code") yield* Deferred.succeed(gotOAuth2, event.loginId);
          }),
        ),
        Effect.forkChild,
      );
      const loginId2 = yield* Deferred.await(gotOAuth2);
      yield* instance.adapter.submitLoginCode!({ loginId: loginId2, code: "valid-code" });
      yield* Fiber.join(loginFiber2);
      assert.equal(verifiedEvents[1]?.type, "authenticated");
    }).pipe(Effect.provide(configLayer)),
);
