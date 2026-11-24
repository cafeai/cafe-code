// @effect-diagnostics nodeBuiltinImport:off
import { fileURLToPath } from "node:url";

import { ProviderInstanceId } from "@cafecode/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { GeminiDriver } from "./GeminiDriver.ts";

const configLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "cafecode-gemini-driver-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));
const fixture = fileURLToPath(new URL("../testUtils/geminiAcpFixture.cjs", import.meta.url));

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
