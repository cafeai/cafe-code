import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it, assert } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as CodexErrors from "effect-codex-app-server/errors";
import {
  ClaudeSettings,
  CodexSettings,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettings,
  type ServerProvider,
  type ServerProviderSlashCommand,
  type ServerSettings as ContractServerSettings,
} from "@cafecode/contracts";
import * as PlatformError from "effect/PlatformError";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { deepMerge } from "@cafecode/shared/Struct";
import { createModelCapabilities } from "@cafecode/shared/model";
import { applyServerSettingsPatch } from "@cafecode/shared/serverSettings";

import {
  CODEX_CLI_LOGIN_STATUS_TIMEOUT_MESSAGE,
  checkCodexCliProviderStatus,
  checkCodexProviderStatus,
  isCodexCliLoginStatusProbeInconclusive,
  readCodexAccountRateLimits,
  type CodexAppServerProviderSnapshot,
} from "./CodexProvider.ts";
import {
  checkClaudeProviderStatus,
  formatClaudeModelUpgradeMessage,
  formatClaudeSubscriptionAuthLabel,
  getBuiltInClaudeModelsForVersion,
} from "./ClaudeProvider.ts";
import { OpenCodeRuntimeLive } from "../opencodeRuntime.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "./ProviderEventLoggers.ts";
import {
  deriveProviderInstanceConfigMap,
  ProviderInstanceRegistryHydrationLive,
} from "./ProviderInstanceRegistryHydration.ts";
import {
  haveProvidersChanged,
  INITIAL_PROVIDER_REFRESH_CONCURRENCY,
  mergeProviderAccountRateLimitSnapshot,
  mergeProviderSnapshot,
  mergeProviderSnapshots,
  ProviderRegistryLive,
  selectProvidersByKind,
} from "./ProviderRegistry.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService, type ServerSettingsShape } from "../../serverSettings.ts";
import {
  hydrateCachedProvider,
  readProviderStatusCache,
  resolveProviderStatusCachePath,
} from "../providerStatusCache.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderInstanceRegistryMutator } from "../Services/ProviderInstanceRegistryMutator.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { parseCodexRateLimitUpdate } from "../codexRateLimits.ts";
import { supportsSubagentConcurrency } from "../Drivers/SubagentConcurrency.ts";
const decodeServerSettings = Schema.decodeSync(ServerSettings);
const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const encodeServerSettings = Schema.encodeSync(ServerSettings);
const encodeUnknownJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
// Registry tests provide narrow process-spawner fakes for the provider under
// test. Keep unrelated OpenCode and Grok probes disabled in that shared fixture
// so tests cannot launch an ambient provider or wait for a protocol handshake
// that their Codex/Claude-only fake was never designed to emit.
const encodedDefaultServerSettings = deepMerge(encodeServerSettings(DEFAULT_SERVER_SETTINGS), {
  providers: { opencode: { enabled: false }, grok: { enabled: false } },
});

const defaultClaudeSettings: ClaudeSettings = Schema.decodeSync(ClaudeSettings)({});
const defaultCodexSettings: CodexSettings = decodeCodexSettings({});
const disabledCodexSettings: CodexSettings = decodeCodexSettings({
  enabled: false,
});
// A fake subprocess does not isolate the filesystem work performed after its
// login response. Omit ambient HOME/CODEX_HOME and credentials from every
// lightweight status fixture; explicit homes below contain synthetic auth only.
const isolatedCodexProbeEnvironment: NodeJS.ProcessEnv = {};

// ── Test helpers ────────────────────────────────────────────────────

const encoder = new TextEncoder();

const TestHttpClientLive = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
  ),
);

function selectDescriptor(
  id: string,
  label: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
) {
  return {
    id,
    label,
    type: "select" as const,
    options: [...options],
    ...(options.find((option) => option.isDefault)?.id
      ? { currentValue: options.find((option) => option.isDefault)?.id }
      : {}),
  };
}

function booleanDescriptor(id: string, label: string) {
  return {
    id,
    label,
    type: "boolean" as const,
  };
}

type TestClaudeCapabilities = {
  readonly email: string | undefined;
  readonly subscriptionType: string | undefined;
  readonly tokenSource: string | undefined;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
};

function claudeCapabilities(overrides: Partial<TestClaudeCapabilities> = {}) {
  return () =>
    Effect.succeed({
      email: undefined,
      subscriptionType: undefined,
      tokenSource: undefined,
      slashCommands: [],
      ...overrides,
    });
}

const noClaudeCapabilities = () =>
  Effect.sync(() => undefined as TestClaudeCapabilities | undefined);

function mockHandle(result: { stdout: string; stderr: string; code: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout)),
    stderr: Stream.make(encoder.encode(result.stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function mockSpawnerLayer(
  handler: (args: ReadonlyArray<string>) => {
    stdout: string;
    stderr: string;
    code: number;
  },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as { args: ReadonlyArray<string> };
      return Effect.succeed(mockHandle(handler(cmd.args)));
    }),
  );
}

function recordingMockSpawnerLayer(
  handler: (args: ReadonlyArray<string>) => {
    stdout: string;
    stderr: string;
    code: number;
  },
) {
  const commands: Array<{
    readonly args: ReadonlyArray<string>;
    readonly env: NodeJS.ProcessEnv | undefined;
  }> = [];
  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as {
        args: ReadonlyArray<string>;
        options?: {
          readonly env?: NodeJS.ProcessEnv;
        };
      };
      commands.push({ args: cmd.args, env: cmd.options?.env });
      return Effect.succeed(mockHandle(handler(cmd.args)));
    }),
  );
  return { layer, commands };
}

function encodeJwtPart(value: unknown): string {
  return Buffer.from(encodeUnknownJsonString(value), "utf8").toString("base64url");
}

function makeUnsignedJwt(payload: Record<string, unknown>): string {
  return `${encodeJwtPart({ alg: "none", typ: "JWT" })}.${encodeJwtPart(payload)}.signature`;
}

function failingSpawnerLayer(description: string) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description,
        }),
      ),
    ),
  );
}

function hangingScopedSpawnerLayer(killCalls: Ref.Ref<number>) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.gen(function* () {
        const handle = ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Ref.update(killCalls, (current) => current + 1),
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.never,
          stderr: Stream.never,
          all: Stream.never,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
        yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
        return handle;
      }),
    ),
  );
}

const codexModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    selectDescriptor("reasoningEffort", "Reasoning", [
      { id: "high", label: "High", isDefault: true },
      { id: "low", label: "Low" },
    ]),
    booleanDescriptor("fastMode", "Fast Mode"),
  ],
}) satisfies NonNullable<ServerProvider["models"][number]["capabilities"]>;

function makeCodexProbeSnapshot(
  input: Partial<CodexAppServerProviderSnapshot> = {},
): CodexAppServerProviderSnapshot {
  return {
    version: "1.0.0",
    account: {
      account: {
        type: "chatgpt",
        email: "test@example.com",
        planType: "pro",
      },
      requiresOpenaiAuth: false,
    },
    models: [
      {
        slug: "gpt-live-codex",
        name: "GPT Live Codex",
        isCustom: false,
        capabilities: codexModelCapabilities,
      },
    ],
    skills: [],
    ...input,
  };
}

function makeMutableServerSettingsService(
  initial: ContractServerSettings = DEFAULT_SERVER_SETTINGS,
) {
  return Effect.gen(function* () {
    const settingsRef = yield* Ref.make(initial);
    const changes = yield* PubSub.unbounded<ContractServerSettings>();

    return {
      start: Effect.void,
      ready: Effect.void,
      getSettings: Ref.get(settingsRef),
      updateSettings: (patch) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(settingsRef);
          const next = applyServerSettingsPatch(current, patch);
          encodeServerSettings(next);
          yield* Ref.set(settingsRef, next);
          yield* PubSub.publish(changes, next);
          return next;
        }),
      get streamChanges() {
        return Stream.concat(Stream.fromEffect(Ref.get(settingsRef)), Stream.fromPubSub(changes));
      },
    } satisfies ServerSettingsShape;
  });
}

it.layer(Layer.mergeAll(NodeServices.layer, ServerSettingsService.layerTest(), TestHttpClientLive))(
  "ProviderRegistry",
  (it) => {
    describe("checkCodexProviderStatus", () => {
      it.effect(
        "keeps GPT-5.5 retirement availability scoped to each native account catalogue",
        () =>
          Effect.gen(function* () {
            // Retirement applies to ChatGPT sign-in, not API-key authentication.
            // These are synthetic account/catalogue responses: there is no date
            // guess, credential read, or attempt to infer account entitlement.
            const current = makeCodexProbeSnapshot().models;
            const chatgpt = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
              Effect.succeed(makeCodexProbeSnapshot({ models: current })),
            );
            const apiModel = {
              slug: "gpt-5.5",
              name: "API GPT-5.5",
              isCustom: false,
              capabilities: codexModelCapabilities,
            };
            const apiKey = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
              Effect.succeed(
                makeCodexProbeSnapshot({
                  account: { account: { type: "apiKey" }, requiresOpenaiAuth: false },
                  models: [...current, apiModel],
                }),
              ),
            );
            assert.equal(chatgpt.auth.type, "chatgpt");
            assert.deepStrictEqual(chatgpt.models, current);
            assert.equal(
              chatgpt.models.some((model) => model.slug === "gpt-5.5"),
              false,
            );
            assert.equal(apiKey.auth.type, "apiKey");
            assert.deepStrictEqual(apiKey.models, [...current, apiModel]);
            assert.deepStrictEqual(
              apiKey.models.find((model) => model.slug === "gpt-5.5"),
              apiModel,
            );
          }),
      );

      it.effect("uses the app-server account and model list for provider status", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
            Effect.succeed(
              makeCodexProbeSnapshot({
                skills: [
                  {
                    name: "github:gh-fix-ci",
                    path: "/Users/test/.codex/skills/gh-fix-ci/SKILL.md",
                    enabled: true,
                    displayName: "CI Debug",
                    shortDescription: "Debug failing GitHub Actions checks",
                  },
                ],
              }),
            ),
          );
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.version, "1.0.0");
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "chatgpt");
          assert.strictEqual(status.auth.label, "ChatGPT Pro 200 Subscription");
          assert.strictEqual(status.auth.email, "test@example.com");
          assert.deepStrictEqual(status.models, [
            {
              slug: "gpt-live-codex",
              name: "GPT Live Codex",
              isCustom: false,
              capabilities: codexModelCapabilities,
            },
          ]);
          assert.deepStrictEqual(status.skills, [
            {
              name: "github:gh-fix-ci",
              path: "/Users/test/.codex/skills/gh-fix-ci/SKILL.md",
              enabled: true,
              displayName: "CI Debug",
              shortDescription: "Debug failing GitHub Actions checks",
            },
          ]);
        }),
      );

      it.effect("labels the Codex promax account without inferring a quota multiplier", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
            Effect.succeed(
              makeCodexProbeSnapshot({
                account: {
                  account: {
                    type: "chatgpt",
                    email: "max@example.com",
                    planType: "promax",
                  },
                  requiresOpenaiAuth: false,
                },
              }),
            ),
          );

          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.label, "ChatGPT Pro 500 Subscription");
        }),
      );

      it.effect("labels the Codex ent26 plan as an Enterprise subscription", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
            Effect.succeed(
              makeCodexProbeSnapshot({
                account: {
                  account: {
                    type: "chatgpt",
                    email: "enterprise@example.com",
                    planType: "ent26",
                  },
                  requiresOpenaiAuth: false,
                },
              }),
            ),
          );

          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.label, "ChatGPT Enterprise Subscription");
        }),
      );

      it.effect("labels the Codex education plan variants without collapsing their SKU", () =>
        Effect.gen(function* () {
          const eduPlus = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
            Effect.succeed(
              makeCodexProbeSnapshot({
                account: {
                  account: {
                    type: "chatgpt",
                    email: "plus@university.example",
                    planType: "edu_plus",
                  },
                  requiresOpenaiAuth: false,
                },
              }),
            ),
          );
          const eduPro = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
            Effect.succeed(
              makeCodexProbeSnapshot({
                account: {
                  account: {
                    type: "chatgpt",
                    email: "pro@university.example",
                    planType: "edu_pro",
                  },
                  requiresOpenaiAuth: false,
                },
              }),
            ),
          );

          assert.strictEqual(eduPlus.auth.label, "ChatGPT Edu Plus Subscription");
          assert.strictEqual(eduPro.auth.label, "ChatGPT Edu Pro Subscription");
        }),
      );

      it.effect("returns unauthenticated when app-server requires OpenAI auth", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
            Effect.succeed(
              makeCodexProbeSnapshot({
                account: {
                  account: null,
                  requiresOpenaiAuth: true,
                },
              }),
            ),
          );

          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.auth.status, "unauthenticated");
          assert.strictEqual(
            status.message,
            "Codex CLI is not authenticated. Run `codex login` and try again.",
          );
        }),
      );

      it.effect(
        "returns ready with unknown auth when app-server does not require OpenAI auth",
        () =>
          Effect.gen(function* () {
            const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
              Effect.succeed(
                makeCodexProbeSnapshot({
                  account: {
                    account: null,
                    requiresOpenaiAuth: false,
                  },
                }),
              ),
            );

            assert.strictEqual(status.status, "ready");
            assert.strictEqual(status.auth.status, "unknown");
          }),
      );

      it.effect("returns an api key label for codex api key auth", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
            Effect.succeed(
              makeCodexProbeSnapshot({
                account: {
                  account: { type: "apiKey" },
                  requiresOpenaiAuth: false,
                },
              }),
            ),
          );

          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "apiKey");
          assert.strictEqual(status.auth.label, "OpenAI API Key");
        }),
      );

      it.effect("returns an Amazon Bedrock label for codex Bedrock auth", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
            Effect.succeed(
              makeCodexProbeSnapshot({
                account: {
                  account: { type: "amazonBedrock" },
                  requiresOpenaiAuth: false,
                },
              }),
            ),
          );

          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "amazonBedrock");
          assert.strictEqual(status.auth.label, "Amazon Bedrock");
        }),
      );

      it.effect("returns unavailable when codex is missing", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
            Effect.fail(
              new CodexErrors.CodexAppServerSpawnError({
                command: "codex app-server",
                cause: new Error("spawn codex ENOENT"),
              }),
            ),
          );
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.installed, false);
          assert.strictEqual(status.auth.status, "unknown");
          assert.strictEqual(
            status.message,
            "Codex CLI (`codex`) is not installed or not on PATH.",
          );
        }),
      );

      it.effect("closes the app-server probe scope when provider status times out", () =>
        Effect.gen(function* () {
          const killCalls = yield* Ref.make(0);
          const statusFiber = yield* checkCodexProviderStatus(
            defaultCodexSettings,
            undefined,
            isolatedCodexProbeEnvironment,
          ).pipe(Effect.provide(hangingScopedSpawnerLayer(killCalls)), Effect.forkChild);

          yield* Effect.yieldNow;
          yield* TestClock.adjust("11 seconds");
          yield* Effect.yieldNow;

          const status = yield* Fiber.join(statusFiber);
          assert.strictEqual(status.status, "error");
          assert.strictEqual(
            status.message,
            "Timed out while checking Codex app-server provider status.",
          );
          assert.strictEqual(yield* Ref.get(killCalls), 1);
        }),
      );
    });

    describe("ProviderRegistryLive", () => {
      it("treats equal provider snapshots as unchanged", () => {
        const providers = [
          {
            instanceId: ProviderInstanceId.make("codex"),
            driver: ProviderDriverKind.make("codex"),
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-03-25T00:00:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          },
          {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            driver: ProviderDriverKind.make("claudeAgent"),
            status: "warning",
            enabled: true,
            installed: true,
            auth: { status: "unknown" },
            checkedAt: "2026-03-25T00:00:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          },
        ] as const satisfies ReadonlyArray<ServerProvider>;

        assert.strictEqual(haveProvidersChanged(providers, [...providers]), false);
      });

      it("preserves previously discovered provider models when a refresh returns none", () => {
        const previousProvider = {
          instanceId: ProviderInstanceId.make("external_provider"),
          driver: ProviderDriverKind.make("externalDriver"),
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-04-14T00:00:00.000Z",
          version: "2026.04.09-f2b0fcd",
          models: [
            {
              slug: "claude-opus-4-6",
              name: "Opus 4.6",
              isCustom: false,
              capabilities: createModelCapabilities({
                optionDescriptors: [
                  selectDescriptor("reasoning", "Reasoning", [
                    { id: "high", label: "High", isDefault: true },
                  ]),
                  booleanDescriptor("fastMode", "Fast Mode"),
                  booleanDescriptor("thinking", "Thinking"),
                ],
              }),
            },
          ],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const refreshedProvider = {
          ...previousProvider,
          checkedAt: "2026-04-14T00:01:00.000Z",
          models: [],
        } satisfies ServerProvider;

        assert.deepStrictEqual(mergeProviderSnapshot(previousProvider, refreshedProvider).models, [
          ...previousProvider.models,
        ]);
      });

      it("retains cached conclusive auth for bounded inconclusive startup probes", () => {
        const previousProvider = {
          instanceId: ProviderInstanceId.make("codex"),
          driver: ProviderDriverKind.make("codex"),
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated", type: "chatgpt", email: "safe@example.com" },
          checkedAt: "2026-04-14T00:00:00.000Z",
          version: "0.133.0",
          models: [],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const inconclusiveProvider = {
          ...previousProvider,
          status: "warning",
          auth: { status: "unknown" },
          checkedAt: "2026-04-14T00:05:00.000Z",
          message: CODEX_CLI_LOGIN_STATUS_TIMEOUT_MESSAGE,
          probeDiagnostics: {
            attemptCount: 1,
            consecutiveInconclusiveCount: 1,
            lastOutcome: "inconclusive",
            lastStartedAt: "2026-04-14T00:04:56.000Z",
            lastFinishedAt: "2026-04-14T00:05:00.000Z",
            lastDurationMs: 4_000,
            periodicIntervalMs: 300_000,
            periodicPhaseOffsetMs: 42_000,
            nextScheduledAt: "2026-04-14T00:10:42.000Z",
          },
        } as const satisfies ServerProvider;

        const retained = mergeProviderSnapshot(previousProvider, inconclusiveProvider);
        assert.strictEqual(retained.status, "ready");
        assert.deepStrictEqual(retained.auth, previousProvider.auth);
        assert.strictEqual(retained.checkedAt, previousProvider.checkedAt);
        assert.isUndefined(retained.message);
        assert.strictEqual(retained.probeDiagnostics?.lastOutcome, "inconclusive");
        assert.strictEqual(retained.probeDiagnostics?.consecutiveInconclusiveCount, 1);

        // The direct refresh result and the provider change stream can deliver
        // the exact same observation. It must not consume another allowance.
        const duplicate = mergeProviderSnapshot(retained, inconclusiveProvider);
        assert.strictEqual(duplicate.probeDiagnostics?.consecutiveInconclusiveCount, 1);

        const reorderedSchedulelessDuplicate = mergeProviderSnapshot(retained, {
          ...inconclusiveProvider,
          probeDiagnostics: {
            ...inconclusiveProvider.probeDiagnostics,
            nextScheduledAt: null,
          },
        });
        assert.strictEqual(
          reorderedSchedulelessDuplicate.probeDiagnostics?.nextScheduledAt,
          inconclusiveProvider.probeDiagnostics.nextScheduledAt,
        );

        const conclusiveScheduledProvider = {
          ...previousProvider,
          checkedAt: "2026-04-14T00:20:00.000Z",
          probeDiagnostics: {
            attemptCount: 3,
            consecutiveInconclusiveCount: 0,
            lastOutcome: "ready",
            lastStartedAt: "2026-04-14T00:19:50.000Z",
            lastFinishedAt: "2026-04-14T00:20:00.000Z",
            lastDurationMs: 10_000,
            periodicIntervalMs: 300_000,
            periodicPhaseOffsetMs: 42_000,
            nextScheduledAt: "2026-04-14T00:30:42.000Z",
          },
        } as const satisfies ServerProvider;
        const reorderedEarlierSchedule = mergeProviderSnapshot(conclusiveScheduledProvider, {
          ...conclusiveScheduledProvider,
          probeDiagnostics: {
            ...conclusiveScheduledProvider.probeDiagnostics,
            nextScheduledAt: "2026-04-14T00:25:42.000Z",
          },
        });
        assert.strictEqual(
          reorderedEarlierSchedule.probeDiagnostics?.nextScheduledAt,
          conclusiveScheduledProvider.probeDiagnostics.nextScheduledAt,
        );

        const retainedAfterSecond = mergeProviderSnapshot(duplicate, {
          ...inconclusiveProvider,
          probeDiagnostics: {
            ...inconclusiveProvider.probeDiagnostics,
            attemptCount: 2,
            consecutiveInconclusiveCount: 2,
            lastStartedAt: "2026-04-14T00:09:56.000Z",
            lastFinishedAt: "2026-04-14T00:10:00.000Z",
          },
        });
        assert.strictEqual(retainedAfterSecond.status, "ready");
        assert.strictEqual(retainedAfterSecond.probeDiagnostics?.consecutiveInconclusiveCount, 2);

        // A delayed direct/stream observation from the first attempt must not
        // look like a provider-scope reset or manufacture a third failure.
        const retainedAfterStaleObservation = mergeProviderSnapshot(
          retainedAfterSecond,
          inconclusiveProvider,
        );
        assert.strictEqual(retainedAfterStaleObservation.status, "ready");
        assert.strictEqual(
          retainedAfterStaleObservation.probeDiagnostics?.consecutiveInconclusiveCount,
          2,
        );

        const hydratedAfterRestart = hydrateCachedProvider({
          cachedProvider: retainedAfterSecond,
          fallbackProvider: {
            ...previousProvider,
            probeDiagnostics: {
              attemptCount: 0,
              consecutiveInconclusiveCount: 0,
              lastOutcome: "pending",
              lastStartedAt: null,
              lastFinishedAt: null,
              lastDurationMs: null,
              periodicIntervalMs: 300_000,
              periodicPhaseOffsetMs: 77_000,
              nextScheduledAt: null,
            },
          },
        });
        assert.strictEqual(hydratedAfterRestart.probeDiagnostics?.consecutiveInconclusiveCount, 2);
        assert.strictEqual(hydratedAfterRestart.probeDiagnostics?.periodicPhaseOffsetMs, 77_000);
        assert.isNull(hydratedAfterRestart.probeDiagnostics?.nextScheduledAt);

        // Rebuilding the backend/provider resets its local attempt counter.
        // The cached streak must carry across that reset so the next timeout is
        // still the third failure rather than another first failure.
        const degraded = mergeProviderSnapshot(hydratedAfterRestart, {
          ...inconclusiveProvider,
          probeDiagnostics: {
            ...inconclusiveProvider.probeDiagnostics,
            attemptCount: 1,
            consecutiveInconclusiveCount: 1,
            lastStartedAt: "2026-04-14T00:14:56.000Z",
            lastFinishedAt: "2026-04-14T00:15:00.000Z",
          },
        });
        assert.strictEqual(degraded.status, "warning");
        assert.strictEqual(degraded.auth.status, "unknown");
        assert.strictEqual(degraded.message, CODEX_CLI_LOGIN_STATUS_TIMEOUT_MESSAGE);
        assert.strictEqual(degraded.probeDiagnostics?.consecutiveInconclusiveCount, 3);

        const recovered = mergeProviderSnapshot(degraded, {
          ...previousProvider,
          checkedAt: "2026-04-14T00:20:00.000Z",
          probeDiagnostics: {
            ...inconclusiveProvider.probeDiagnostics,
            attemptCount: 2,
            consecutiveInconclusiveCount: 0,
            lastOutcome: "ready",
            lastStartedAt: "2026-04-14T00:19:59.000Z",
            lastFinishedAt: "2026-04-14T00:20:00.000Z",
          },
        });
        assert.strictEqual(recovered.status, "ready");
        assert.strictEqual(recovered.probeDiagnostics?.consecutiveInconclusiveCount, 0);
      });

      it("preserves event-sourced account rate limits when a refresh omits them", () => {
        const previousProvider = {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          driver: ProviderDriverKind.make("claudeAgent"),
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-04-14T00:00:00.000Z",
          version: "2026.04.09-f2b0fcd",
          models: [],
          slashCommands: [],
          skills: [],
          accountRateLimits: {
            rateLimits: { primary: { windowDurationMins: 300, resetsAt: 1782274800 } },
            checkedAt: "2026-04-14T00:00:00.000Z",
          },
        } as const satisfies ServerProvider;
        // The Claude probe never sends a prompt, so its refreshed snapshot carries no
        // accountRateLimits — the merge must keep the previously accrued limits.
        const { accountRateLimits: _omitted, ...withoutRateLimits } = previousProvider;
        const refreshedProvider = {
          ...withoutRateLimits,
          checkedAt: "2026-04-14T00:05:00.000Z",
        } satisfies ServerProvider;

        assert.deepStrictEqual(
          mergeProviderSnapshot(previousProvider, refreshedProvider).accountRateLimits,
          previousProvider.accountRateLimits,
        );
      });

      it("lets a refresh that reports account rate limits override the previous ones", () => {
        const previousProvider = {
          instanceId: ProviderInstanceId.make("codex"),
          driver: ProviderDriverKind.make("codex"),
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-04-14T00:00:00.000Z",
          version: "2026.04.09-f2b0fcd",
          models: [],
          slashCommands: [],
          skills: [],
          accountRateLimits: {
            rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300 } },
            checkedAt: "2026-04-14T00:00:00.000Z",
          },
        } as const satisfies ServerProvider;
        const refreshedProvider = {
          ...previousProvider,
          checkedAt: "2026-04-14T00:05:00.000Z",
          accountRateLimits: {
            rateLimits: { primary: { usedPercent: 80, windowDurationMins: 300 } },
            checkedAt: "2026-04-14T00:05:00.000Z",
          },
        } as const satisfies ServerProvider;

        assert.deepStrictEqual(
          mergeProviderSnapshot(previousProvider, refreshedProvider).accountRateLimits,
          refreshedProvider.accountRateLimits,
        );
      });

      it("does not preserve stale Codex account rate limits when a refresh omits them", () => {
        const previousProvider = {
          instanceId: ProviderInstanceId.make("codex"),
          driver: ProviderDriverKind.make("codex"),
          status: "ready",
          enabled: true,
          installed: true,
          auth: {
            status: "authenticated",
            type: "chatgpt",
            label: "ChatGPT Pro 20x Subscription",
            email: "old@example.test",
          },
          checkedAt: "2026-04-14T00:00:00.000Z",
          version: "2026.04.09-f2b0fcd",
          models: [],
          slashCommands: [],
          skills: [],
          accountRateLimits: {
            rateLimits: {
              planType: "pro",
              primary: { usedPercent: 88, windowDurationMins: 300 },
            },
            rateLimitResetCredits: { availableCount: 1 },
            checkedAt: "2026-04-14T00:00:00.000Z",
          },
        } as const satisfies ServerProvider;
        const { accountRateLimits: _omitted, ...withoutRateLimits } = previousProvider;
        const refreshedProvider = {
          ...withoutRateLimits,
          auth: {
            status: "authenticated",
            type: "chatgpt",
            label: "ChatGPT Subscription",
            email: "new@example.test",
          },
          checkedAt: "2026-04-14T00:05:00.000Z",
        } as const satisfies ServerProvider;

        assert.strictEqual(
          mergeProviderSnapshot(previousProvider, refreshedProvider).accountRateLimits,
          undefined,
        );
        assert.strictEqual(
          mergeProviderSnapshot(previousProvider, refreshedProvider).auth.label,
          "ChatGPT Subscription",
        );
      });

      it("does not preserve Grok usage when a full refresh omits account identity and quota", () => {
        const previousProvider = {
          instanceId: ProviderInstanceId.make("grok"),
          driver: ProviderDriverKind.make("grok"),
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated", type: "cached-token" },
          checkedAt: "2026-08-16T00:00:00.000Z",
          version: "1.0.4",
          models: [],
          slashCommands: [],
          skills: [],
          accountRateLimits: {
            rateLimits: {
              limitId: "grok",
              primary: { usedPercent: 1, windowDurationMins: 10_080 },
            },
            checkedAt: "2026-08-16T00:00:00.000Z",
          },
        } as const satisfies ServerProvider;
        const { accountRateLimits: _omitted, ...withoutRateLimits } = previousProvider;
        const refreshedProvider = {
          ...withoutRateLimits,
          checkedAt: "2026-08-16T00:05:00.000Z",
        } satisfies ServerProvider;

        assert.strictEqual(
          mergeProviderSnapshot(previousProvider, refreshedProvider).accountRateLimits,
          undefined,
        );
      });

      it("preserves live Codex rate limits across a transient same-account probe omission", () => {
        const previousProvider = {
          instanceId: ProviderInstanceId.make("codex"),
          driver: ProviderDriverKind.make("codex"),
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated", type: "chatgpt", email: "same@example.test" },
          checkedAt: "2026-08-12T10:00:00.000Z",
          version: "0.147.0",
          models: [],
          slashCommands: [],
          skills: [],
          accountRateLimits: {
            rateLimits: {
              limitId: "codex",
              planType: "pro",
              primary: { usedPercent: 1, windowDurationMins: 10_080 },
            },
            checkedAt: "2026-08-12T10:00:00.000Z",
          },
        } as const satisfies ServerProvider;
        const { accountRateLimits: _omitted, ...withoutRateLimits } = previousProvider;
        const refreshedProvider = {
          ...withoutRateLimits,
          checkedAt: "2026-08-12T10:05:00.000Z",
        } satisfies ServerProvider;

        assert.deepStrictEqual(
          mergeProviderSnapshot(previousProvider, refreshedProvider).accountRateLimits,
          previousProvider.accountRateLimits,
        );
        // Quota retention is not fresh subscription evidence. An omitted plan
        // must not acquire a tier merely because cached same-account usage exists.
        assert.strictEqual(
          mergeProviderSnapshot(previousProvider, refreshedProvider).auth.label,
          undefined,
        );
      });

      it("merges sparse live Codex rate limits into the latest full snapshot", () => {
        const merged = mergeProviderAccountRateLimitSnapshot({
          previous: {
            rateLimits: {
              limitId: "codex",
              planType: "pro",
              primary: { usedPercent: 0, windowDurationMins: 300 },
              secondary: { usedPercent: 20, windowDurationMins: 10_080 },
            },
            rateLimitsByLimitId: {
              codex: {
                limitId: "codex",
                planType: "pro",
                primary: { usedPercent: 0, windowDurationMins: 300 },
                secondary: { usedPercent: 20, windowDurationMins: 10_080 },
              },
              codex_bengalfox: {
                limitId: "codex_bengalfox",
                primary: { usedPercent: 5, windowDurationMins: 60 },
              },
            },
            rateLimitResetCredits: { availableCount: 1 },
            checkedAt: "2026-08-12T10:00:00.000Z",
          },
          limitId: "codex",
          snapshot: {
            limitId: "codex",
            primary: { usedPercent: 1, windowDurationMins: 10_080 },
          },
          checkedAt: "2026-08-12T10:01:00.000Z",
        });

        assert.deepStrictEqual(merged.rateLimits, {
          limitId: "codex",
          planType: "pro",
          primary: { usedPercent: 1, windowDurationMins: 10_080 },
          secondary: { usedPercent: 20, windowDurationMins: 10_080 },
        });
        assert.deepStrictEqual(merged.rateLimitsByLimitId?.codex, merged.rateLimits);
        assert.strictEqual(merged.rateLimitsByLimitId?.codex_bengalfox?.primary?.usedPercent, 5);
        assert.deepStrictEqual(merged.rateLimitResetCredits, { availableCount: 1 });
        assert.strictEqual(merged.checkedAt, "2026-08-12T10:01:00.000Z");
      });

      it("retains quota aliases across sparse updates without borrowing canonical credits", () => {
        const previous = {
          rateLimits: {
            limitId: "codex",
            normalModelSlug: null,
            credits: { hasCredits: true, unlimited: false, balance: "9.99" },
          },
          rateLimitsByLimitId: {
            reserve: {
              limitId: "reserve",
              normalModelSlug: "gpt-5.6-luna",
              credits: { hasCredits: false, unlimited: false, balance: "0" },
              rateLimitReachedType: "workspace_member_credits_depleted",
              secondary: { usedPercent: 25 },
            },
          },
          checkedAt: "2026-09-29T00:00:00.000Z",
        };
        const update = parseCodexRateLimitUpdate({
          rateLimits: {
            limitId: "reserve",
            normalModelSlug: null,
            credits: null,
            rateLimitReachedType: null,
            primary: { usedPercent: 0 },
          },
        });
        assert.ok(update);
        const merged = mergeProviderAccountRateLimitSnapshot({
          previous,
          ...update,
          checkedAt: "2026-09-29T00:01:00.000Z",
        });
        assert.deepStrictEqual(merged.rateLimits, previous.rateLimits);
        assert.deepStrictEqual(merged.rateLimitsByLimitId?.reserve, {
          ...previous.rateLimitsByLimitId.reserve,
          primary: { usedPercent: 0 },
        });

        const newBucket = mergeProviderAccountRateLimitSnapshot({
          previous: merged,
          limitId: "another-alias",
          snapshot: { normalModelSlug: "gpt-6-sol", primary: { usedPercent: 0 } },
          checkedAt: "2026-09-29T00:02:00.000Z",
        });
        assert.deepStrictEqual(newBucket.rateLimitsByLimitId?.["another-alias"], {
          normalModelSlug: "gpt-6-sol",
          primary: { usedPercent: 0 },
        });
      });

      it("fills missing capabilities from the previous provider snapshot", () => {
        const previousProvider = {
          instanceId: ProviderInstanceId.make("external_provider"),
          driver: ProviderDriverKind.make("externalDriver"),
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-04-14T00:00:00.000Z",
          version: "2026.04.09-f2b0fcd",
          models: [
            {
              slug: "claude-opus-4-6",
              name: "Opus 4.6",
              isCustom: false,
              capabilities: createModelCapabilities({
                optionDescriptors: [
                  selectDescriptor("reasoning", "Reasoning", [
                    { id: "high", label: "High", isDefault: true },
                  ]),
                  booleanDescriptor("fastMode", "Fast Mode"),
                  booleanDescriptor("thinking", "Thinking"),
                ],
              }),
            },
          ],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const refreshedProvider = {
          ...previousProvider,
          checkedAt: "2026-04-14T00:01:00.000Z",
          models: [
            {
              slug: "claude-opus-4-6",
              name: "Opus 4.6",
              isCustom: false,
              capabilities: createModelCapabilities({
                optionDescriptors: [],
              }),
            },
          ],
        } satisfies ServerProvider;

        assert.deepStrictEqual(mergeProviderSnapshot(previousProvider, refreshedProvider).models, [
          ...previousProvider.models,
        ]);
      });

      it("persists merged provider snapshots for the providers that were refreshed", () => {
        const previousProviders = [
          {
            instanceId: ProviderInstanceId.make("external_provider"),
            driver: ProviderDriverKind.make("externalDriver"),
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-04-14T00:00:00.000Z",
            version: "2026.04.09-f2b0fcd",
            models: [
              {
                slug: "claude-opus-4-6",
                name: "Opus 4.6",
                isCustom: false,
                capabilities: createModelCapabilities({
                  optionDescriptors: [
                    selectDescriptor("reasoning", "Reasoning", [
                      { id: "high", label: "High", isDefault: true },
                    ]),
                    booleanDescriptor("fastMode", "Fast Mode"),
                    booleanDescriptor("thinking", "Thinking"),
                  ],
                }),
              },
            ],
            slashCommands: [],
            skills: [],
          },
          {
            instanceId: ProviderInstanceId.make("codex"),
            driver: ProviderDriverKind.make("codex"),
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-04-14T00:00:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          },
        ] as const satisfies ReadonlyArray<ServerProvider>;
        const refreshedExternalProvider = {
          ...previousProviders[0],
          checkedAt: "2026-04-14T00:01:00.000Z",
          models: [],
        } satisfies ServerProvider;

        const mergedProviders = mergeProviderSnapshots(previousProviders, [
          refreshedExternalProvider,
        ]);
        const persistedProviders = selectProvidersByKind(
          mergedProviders,
          new Set([ProviderDriverKind.make("externalDriver")]),
        );

        assert.deepStrictEqual(persistedProviders, [
          {
            ...refreshedExternalProvider,
            models: [...previousProviders[0].models],
          },
        ]);
      });

      it.effect("persists the merged snapshot when a live update has empty models", () =>
        Effect.gen(function* () {
          const externalDriver = ProviderDriverKind.make("externalDriver");
          const externalInstanceId = ProviderInstanceId.make("external_provider");
          const initialProvider = {
            instanceId: externalInstanceId,
            driver: externalDriver,
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-04-14T00:00:00.000Z",
            version: "2026.04.09-f2b0fcd",
            models: [
              {
                slug: "claude-opus-4-6",
                name: "Opus 4.6",
                isCustom: false,
                capabilities: createModelCapabilities({
                  optionDescriptors: [
                    selectDescriptor("reasoning", "Reasoning", [
                      { id: "high", label: "High", isDefault: true },
                    ]),
                  ],
                }),
              },
            ],
            slashCommands: [],
            skills: [],
          } as const satisfies ServerProvider;
          const refreshedProvider = {
            ...initialProvider,
            checkedAt: "2026-04-14T00:01:00.000Z",
            models: [],
          } satisfies ServerProvider;
          const changes = yield* PubSub.unbounded<ServerProvider>();
          const instance = {
            instanceId: externalInstanceId,
            driverKind: externalDriver,
            continuationIdentity: {
              driverKind: externalDriver,
              continuationKey: "externalDriver:instance:external_provider",
            },
            displayName: undefined,
            enabled: true,
            snapshot: {
              maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
                provider: externalDriver,
                packageName: null,
              }),
              getSnapshot: Effect.succeed(initialProvider),
              refresh: Effect.succeed(refreshedProvider),
              streamChanges: Stream.fromPubSub(changes),
            },
            adapter: {} as ProviderInstance["adapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          } satisfies ProviderInstance;
          const instanceRegistryLayer = Layer.succeed(ProviderInstanceRegistry, {
            getInstance: (instanceId) =>
              Effect.succeed(instanceId === externalInstanceId ? instance : undefined),
            listInstances: Effect.succeed([instance]),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
              PubSub.subscribe(pubsub),
            ),
          });
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const runtimeServices = yield* Layer.build(
            ProviderRegistryLive.pipe(
              Layer.provideMerge(instanceRegistryLayer),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "t3-provider-registry-merged-persist-",
                }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ).pipe(Scope.provide(scope));

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry;
            const config = yield* ServerConfig;
            const filePath = yield* resolveProviderStatusCachePath({
              cacheDir: config.providerStatusCacheDir,
              instanceId: externalInstanceId,
            });

            assert.deepStrictEqual((yield* registry.getProviders)[0]?.models, [
              ...initialProvider.models,
            ]);
            yield* PubSub.publish(changes, refreshedProvider);

            let cachedProvider = yield* readProviderStatusCache(filePath);
            for (
              let attempt = 0;
              attempt < 50 && cachedProvider?.checkedAt !== refreshedProvider.checkedAt;
              attempt += 1
            ) {
              yield* TestClock.adjust("10 millis");
              yield* Effect.yieldNow;
              cachedProvider = yield* readProviderStatusCache(filePath);
            }

            assert.deepStrictEqual(cachedProvider, {
              ...refreshedProvider,
              models: [...initialProvider.models],
            });
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      it.effect("bounds initial provider refresh concurrency across instances", () =>
        Effect.gen(function* () {
          const externalDriver = ProviderDriverKind.make("externalDriver");
          const activeRefreshes = yield* Ref.make(0);
          const maxActiveRefreshes = yield* Ref.make(0);
          const startedRefreshes = yield* Ref.make(0);
          const boundReached = yield* Deferred.make<void>();
          const releaseRefreshes = yield* Deferred.make<void>();
          const instances = Array.from({ length: 5 }, (_, index) => {
            const instanceId = ProviderInstanceId.make(`external_provider_${index}`);
            const provider = {
              instanceId,
              driver: externalDriver,
              status: "ready",
              enabled: true,
              installed: true,
              auth: { status: "authenticated" },
              checkedAt: "2026-04-14T00:00:00.000Z",
              version: "1.0.0",
              models: [],
              slashCommands: [],
              skills: [],
            } as const satisfies ServerProvider;
            const refresh = Effect.gen(function* () {
              const active = yield* Ref.updateAndGet(activeRefreshes, (count) => count + 1);
              yield* Ref.update(maxActiveRefreshes, (maximum) => Math.max(maximum, active));
              const started = yield* Ref.updateAndGet(startedRefreshes, (count) => count + 1);
              if (started === INITIAL_PROVIDER_REFRESH_CONCURRENCY) {
                yield* Deferred.succeed(boundReached, undefined).pipe(Effect.ignore);
              }
              yield* Deferred.await(releaseRefreshes);
              return provider;
            }).pipe(Effect.ensuring(Ref.update(activeRefreshes, (count) => count - 1)));

            return {
              instanceId,
              driverKind: externalDriver,
              continuationIdentity: {
                driverKind: externalDriver,
                continuationKey: `externalDriver:instance:${instanceId}`,
              },
              displayName: undefined,
              enabled: true,
              snapshot: {
                maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
                  provider: externalDriver,
                  packageName: null,
                }),
                getSnapshot: Effect.succeed(provider),
                refresh,
                streamChanges: Stream.empty,
              },
              adapter: {} as ProviderInstance["adapter"],
              textGeneration: {} as ProviderInstance["textGeneration"],
            } satisfies ProviderInstance;
          });
          const instanceRegistryLayer = Layer.succeed(ProviderInstanceRegistry, {
            getInstance: (instanceId) =>
              Effect.succeed(instances.find((instance) => instance.instanceId === instanceId)),
            listInstances: Effect.succeed(instances),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
              PubSub.subscribe(pubsub),
            ),
          });
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const buildFiber = yield* Layer.build(
            ProviderRegistryLive.pipe(
              Layer.provideMerge(instanceRegistryLayer),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "t3-provider-registry-bounded-initial-refresh-",
                }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ).pipe(Scope.provide(scope), Effect.forkChild);

          yield* Deferred.await(boundReached);
          yield* Effect.yieldNow;
          assert.strictEqual(
            yield* Ref.get(maxActiveRefreshes),
            INITIAL_PROVIDER_REFRESH_CONCURRENCY,
          );
          assert.strictEqual(
            yield* Ref.get(startedRefreshes),
            INITIAL_PROVIDER_REFRESH_CONCURRENCY,
          );

          yield* Deferred.succeed(releaseRefreshes, undefined);
          yield* Fiber.join(buildFiber);
          assert.strictEqual(yield* Ref.get(startedRefreshes), instances.length);
        }),
      );

      it.effect("returns the cached provider list when a manual refresh fails", () =>
        Effect.gen(function* () {
          const codexDriver = ProviderDriverKind.make("codex");
          const codexInstanceId = ProviderInstanceId.make("codex");
          const cachedProvider = {
            instanceId: codexInstanceId,
            driver: codexDriver,
            status: "ready",
            enabled: true,
            installed: true,
            auth: {
              status: "authenticated",
              type: "chatgpt",
              label: "ChatGPT Subscription",
              email: "usage-refresh@example.test",
            },
            checkedAt: "2026-04-29T10:00:00.000Z",
            version: "1.0.0",
            models: [
              {
                slug: "gpt-retired-static-fallback",
                name: "GPT Retired Static Fallback",
                isCustom: false,
                capabilities: null,
              },
            ],
            slashCommands: [],
            skills: [],
          } as const satisfies ServerProvider;
          const usageRefreshedProvider = {
            ...cachedProvider,
            accountRateLimits: {
              rateLimits: {
                planType: "prolite",
                primary: {
                  usedPercent: 20,
                  windowDurationMins: 300,
                  resetsAt: 1_780_000_000,
                },
              },
              checkedAt: "2026-04-29T10:01:00.000Z",
            },
          } as const satisfies ServerProvider;
          const modelRefreshedProvider = {
            ...cachedProvider,
            models: [
              {
                slug: "gpt-model-refresh-only",
                name: "GPT Model Refresh Only",
                isCustom: false,
                capabilities: null,
              },
            ],
          } as const satisfies ServerProvider;
          const instance = {
            instanceId: codexInstanceId,
            driverKind: codexDriver,
            continuationIdentity: {
              driverKind: codexDriver,
              continuationKey: "codex:instance:codex",
            },
            displayName: undefined,
            enabled: true,
            snapshot: {
              maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
                provider: codexDriver,
                packageName: null,
              }),
              getSnapshot: Effect.succeed(cachedProvider),
              refresh: Effect.die(new Error("simulated refresh failure")),
              refreshAccountUsage: Effect.succeed(usageRefreshedProvider),
              refreshModels: Effect.succeed(modelRefreshedProvider),
              streamChanges: Stream.empty,
            },
            adapter: {} as ProviderInstance["adapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          } satisfies ProviderInstance;
          const instanceRegistryLayer = Layer.succeed(ProviderInstanceRegistry, {
            getInstance: (instanceId) =>
              Effect.succeed(instanceId === codexInstanceId ? instance : undefined),
            listInstances: Effect.succeed([instance]),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
              PubSub.subscribe(pubsub),
            ),
          });
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const runtimeServices = yield* Layer.build(
            ProviderRegistryLive.pipe(
              Layer.provideMerge(instanceRegistryLayer),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "t3-provider-registry-refresh-failure-",
                }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ).pipe(Scope.provide(scope));

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry;

            assert.deepStrictEqual(yield* registry.getProviders, [cachedProvider]);
            assert.deepStrictEqual(yield* registry.refresh(codexDriver), [cachedProvider]);
            assert.deepStrictEqual(yield* registry.refreshInstance(codexInstanceId), [
              cachedProvider,
            ]);
            assert.deepStrictEqual(yield* registry.refreshInstanceAccountUsage(codexInstanceId), [
              {
                ...usageRefreshedProvider,
                auth: { ...cachedProvider.auth, label: "ChatGPT Pro 100 Subscription" },
              },
            ]);
            assert.deepStrictEqual(yield* registry.refreshInstanceModels!(codexInstanceId), [
              {
                ...modelRefreshedProvider,
                accountRateLimits: usageRefreshedProvider.accountRateLimits,
              },
            ]);

            // Model-only refreshes may retain quota data but do not authenticate
            // that cached plan. Sparse and auxiliary events cannot relabel it.
            yield* registry.updateProviderAccountRateLimits({
              instanceId: codexInstanceId,
              limitId: "codex",
              snapshot: { primary: { usedPercent: 21 } },
              checkedAt: "2026-04-29T10:02:00.000Z",
            });
            assert.strictEqual(
              (yield* registry.getProviders)[0]?.auth.label,
              "ChatGPT Subscription",
            );
            for (const update of [
              { limitId: "codex", planType: "pro", expected: "ChatGPT Pro 200 Subscription" },
              { limitId: "codex", planType: "promax", expected: "ChatGPT Pro 500 Subscription" },
              { limitId: "codex", planType: undefined, expected: "ChatGPT Pro 500 Subscription" },
              { limitId: "codex", planType: null, expected: "ChatGPT Pro 500 Subscription" },
              {
                limitId: "codex_bengalfox",
                planType: "plus",
                expected: "ChatGPT Pro 500 Subscription",
              },
              { limitId: "codex", planType: "unknown", expected: "ChatGPT Subscription" },
              { limitId: "codex", planType: "future-plan", expected: "ChatGPT Subscription" },
              { limitId: "codex", planType: "plus", expected: "ChatGPT Plus Subscription" },
            ]) {
              yield* registry.updateProviderAccountRateLimits({
                instanceId: codexInstanceId,
                limitId: update.limitId,
                snapshot: {
                  ...(update.planType !== undefined ? { planType: update.planType } : {}),
                  primary: { usedPercent: 22 },
                },
                checkedAt: "2026-04-29T10:03:00.000Z",
              });
              assert.strictEqual((yield* registry.getProviders)[0]?.auth.label, update.expected);
            }
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      it.effect(
        "keeps the internal model timeout bounded after caller disconnect without syncing a replaced instance",
        () =>
          Effect.gen(function* () {
            const codexDriver = ProviderDriverKind.make("codex");
            const codexInstanceId = ProviderInstanceId.make("codex");
            const refreshStarted = yield* Deferred.make<void>();
            const refreshTimedOut = yield* Deferred.make<void>();
            const cachedProvider = {
              instanceId: codexInstanceId,
              driver: codexDriver,
              status: "ready",
              enabled: true,
              installed: true,
              auth: { status: "authenticated" },
              checkedAt: "2026-04-29T10:00:00.000Z",
              version: "1.0.0",
              models: [
                {
                  slug: "gpt-current",
                  name: "GPT Current",
                  isCustom: false,
                  capabilities: null,
                },
              ],
              slashCommands: [],
              skills: [],
            } as const satisfies ServerProvider;
            const staleModelProvider = {
              ...cachedProvider,
              models: [
                {
                  slug: "gpt-stale-old-instance",
                  name: "GPT Stale Old Instance",
                  isCustom: false,
                  capabilities: null,
                },
              ],
            } as const satisfies ServerProvider;
            const makeInstance = (refreshModels: Effect.Effect<ServerProvider>) =>
              ({
                instanceId: codexInstanceId,
                driverKind: codexDriver,
                continuationIdentity: {
                  driverKind: codexDriver,
                  continuationKey: "codex:instance:codex",
                },
                displayName: undefined,
                enabled: true,
                snapshot: {
                  maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
                    provider: codexDriver,
                    packageName: null,
                  }),
                  getSnapshot: Effect.succeed(cachedProvider),
                  refresh: Effect.succeed(cachedProvider),
                  refreshModels,
                  streamChanges: Stream.empty,
                },
                adapter: {} as ProviderInstance["adapter"],
                textGeneration: {} as ProviderInstance["textGeneration"],
              }) satisfies ProviderInstance;
            const firstInstance = makeInstance(
              Deferred.succeed(refreshStarted, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.timeoutOption("15 seconds"),
                Effect.tap(() => Deferred.succeed(refreshTimedOut, undefined)),
                Effect.as(staleModelProvider),
              ),
            );
            const replacementInstance = makeInstance(Effect.succeed(cachedProvider));
            const currentInstanceRef = yield* Ref.make<ProviderInstance>(firstInstance);
            const instanceRegistryLayer = Layer.succeed(ProviderInstanceRegistry, {
              getInstance: (instanceId) =>
                instanceId === codexInstanceId
                  ? Ref.get(currentInstanceRef).pipe(Effect.map((instance) => instance))
                  : Effect.succeed(undefined),
              listInstances: Ref.get(currentInstanceRef).pipe(
                Effect.map((instance) => [instance] as const),
              ),
              listUnavailable: Effect.succeed([]),
              streamChanges: Stream.empty,
              subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
                PubSub.subscribe(pubsub),
              ),
            });
            const scope = yield* Scope.make();
            yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
            const runtimeServices = yield* Layer.build(
              ProviderRegistryLive.pipe(
                Layer.provideMerge(instanceRegistryLayer),
                Layer.provideMerge(
                  ServerConfig.layerTest(process.cwd(), {
                    prefix: "t3-provider-registry-stale-model-refresh-",
                  }),
                ),
                Layer.provideMerge(NodeServices.layer),
              ),
            ).pipe(Scope.provide(scope));

            yield* Effect.gen(function* () {
              const registry = yield* ProviderRegistry;
              const refreshFiber = yield* registry.refreshInstanceModels!(codexInstanceId).pipe(
                Effect.forkChild,
              );
              yield* Deferred.await(refreshStarted);

              // Model refresh synchronization deliberately ignores a short-lived
              // RPC caller disconnect, but that outer uninterruptible boundary
              // must not mask the driver's own timeout. Start interruption in a
              // separate fiber because Fiber.interrupt waits for the bounded
              // critical section to finish.
              const disconnectFiber = yield* Fiber.interrupt(refreshFiber).pipe(Effect.forkChild);
              yield* Effect.yieldNow;
              yield* Ref.set(currentInstanceRef, replacementInstance);
              yield* TestClock.adjust("15 seconds");
              yield* Deferred.await(refreshTimedOut);
              yield* Fiber.join(disconnectFiber);

              assert.deepStrictEqual(yield* registry.getProviders, [cachedProvider]);
            }).pipe(Effect.provide(runtimeServices));
          }),
      );

      it.effect("keeps consuming registry changes after one sync fails", () =>
        Effect.gen(function* () {
          const codexDriver = ProviderDriverKind.make("codex");
          const codexInstanceId = ProviderInstanceId.make("codex");
          const claudeDriver = ProviderDriverKind.make("claudeAgent");
          const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
          const codexProvider = {
            instanceId: codexInstanceId,
            driver: codexDriver,
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-04-29T10:00:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          } as const satisfies ServerProvider;
          const claudeProvider = {
            instanceId: claudeInstanceId,
            driver: claudeDriver,
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-04-29T10:01:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          } as const satisfies ServerProvider;
          const makeInstance = (provider: ServerProvider): ProviderInstance => ({
            instanceId: provider.instanceId,
            driverKind: provider.driver,
            continuationIdentity: {
              driverKind: provider.driver,
              continuationKey: `${provider.driver}:instance:${provider.instanceId}`,
            },
            displayName: undefined,
            enabled: true,
            snapshot: {
              maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
                provider: provider.driver,
                packageName: null,
              }),
              getSnapshot: Effect.succeed(provider),
              refresh: Effect.succeed(provider),
              streamChanges: Stream.empty,
            },
            adapter: {} as ProviderInstance["adapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          });
          const codexInstance = makeInstance(codexProvider);
          const claudeInstance = makeInstance(claudeProvider);
          const changes = yield* PubSub.unbounded<void>();
          const instancesRef = yield* Ref.make<ReadonlyArray<ProviderInstance>>([codexInstance]);
          const failNextList = yield* Ref.make(false);
          const wait = () => Effect.yieldNow;
          const instanceRegistryLayer = Layer.succeed(ProviderInstanceRegistry, {
            getInstance: (instanceId) =>
              Ref.get(instancesRef).pipe(
                Effect.map((instances) =>
                  instances.find((instance) => instance.instanceId === instanceId),
                ),
              ),
            listInstances: Effect.gen(function* () {
              const shouldFail = yield* Ref.get(failNextList);
              if (shouldFail) {
                yield* Ref.set(failNextList, false);
                return yield* Effect.die(new Error("simulated registry list failure"));
              }
              return yield* Ref.get(instancesRef);
            }),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.fromPubSub(changes),
            subscribeChanges: PubSub.subscribe(changes),
          });
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const runtimeServices = yield* Layer.build(
            ProviderRegistryLive.pipe(
              Layer.provideMerge(instanceRegistryLayer),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "t3-provider-registry-sync-failure-",
                }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ).pipe(Scope.provide(scope));

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry;
            assert.deepStrictEqual(yield* registry.getProviders, [codexProvider]);

            yield* Ref.set(failNextList, true);
            yield* PubSub.publish(changes, undefined);

            yield* Ref.set(instancesRef, [codexInstance, claudeInstance]);
            yield* PubSub.publish(changes, undefined);

            let providers = yield* registry.getProviders;
            for (
              let attempt = 0;
              attempt < 50 &&
              !providers.some((provider) => provider.instanceId === claudeInstanceId);
              attempt += 1
            ) {
              yield* wait();
              providers = yield* registry.getProviders;
            }

            assert.deepStrictEqual(
              providers.map((provider) => provider.instanceId).toSorted(),
              [codexInstanceId, claudeInstanceId].toSorted(),
            );
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      // If the aggregator's `syncLiveSources` breaks — the
      // `codex_personal`-never-probes bug we are guarding against — that
      // snapshot never lands in `getProviders` and the assertions below fail.
      it.effect("propagates Codex probe failures to the aggregator at boot", () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const isolatedCodexHome = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "cafe-provider-registry-boot-home-",
          });
          const missingBinary = path.join(
            isolatedCodexHome,
            process.platform === "win32" ? "missing-codex.exe" : "missing-codex",
          );
          const serverSettings = yield* makeMutableServerSettingsService(
            decodeServerSettings(
              deepMerge(encodedDefaultServerSettings, {
                providers: {
                  // Disable the remaining built-in probes that would otherwise
                  // spawn on the CI host. `enabled: false` short-circuits each
                  // driver's probe *before* it touches the spawner, so the
                  // test environment stays isolated from the dev
                  // machine's PATH.
                  codex: { enabled: false },
                  claudeAgent: { enabled: false },
                },
                // `providerInstances` keys are branded `ProviderInstanceId`;
                // the branded index signature rejects plain string literals
                // at the TS level even though the runtime schema happily
                // accepts + decodes them. Cast the patch to `unknown` so
                // the `Schema.decodeSync` below does the real validation.
                providerInstances: {
                  // Matches the shape the user had in `.t3/dev/settings.json`
                  // when the bug was reported: a custom enabled Codex instance
                  // pointing at a binary the server has to actually spawn.
                  codex_personal: {
                    driver: "codex",
                    displayName: "Codex Personal",
                    enabled: true,
                    config: {
                      binaryPath: missingBinary,
                      homePath: isolatedCodexHome,
                    },
                  },
                } as unknown as ContractServerSettings["providerInstances"],
              }),
            ),
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const providerRegistryLayer = ProviderRegistryLive.pipe(
            Layer.provideMerge(ProviderInstanceRegistryHydrationLive),
            Layer.provideMerge(Layer.succeed(ServerSettingsService, serverSettings)),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-",
              }),
            ),
            Layer.provideMerge(TestHttpClientLive),
            Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
            Layer.provideMerge(OpenCodeRuntimeLive),
            Layer.provideMerge(failingSpawnerLayer("spawn codex ENOENT")),
          );
          const runtimeServices = yield* Layer.build(providerRegistryLayer).pipe(
            Scope.provide(scope),
          );

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry;
            const providers = yield* registry.getProviders;
            const codexPersonal = providers.find(
              (provider) => provider.instanceId === "codex_personal",
            );
            assert.notStrictEqual(
              codexPersonal,
              undefined,
              `Expected the aggregator to know about codex_personal; instead saw: ${providers
                .map((provider) => provider.instanceId)
                .join(", ")}`,
            );
            assert.strictEqual(
              codexPersonal?.status,
              "error",
              "A Codex probe failure should surface as 'error' in the aggregator",
            );
            assert.strictEqual(codexPersonal?.installed, false);
            assert.strictEqual(
              codexPersonal?.message,
              "Codex CLI (`codex`) is not installed or not on PATH.",
            );
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      // Guards the second half of the reported bug: changing
      // `providers.codex.binaryPath` in settings must tear down the live
      // instance and rebuild it so a fresh probe runs with the new binary.
      // This test drives the real settings stream → registry reconcile →
      // aggregator sync pipeline and asserts that `getProviders` reflects
      // the new probe's outcome. If `syncLiveSources` stops awaiting the
      // rebuilt instance's refresh (previous bug mode), the aggregator
      // keeps the old snapshot and this test fails.
      //
      it.effect("re-probes when settings change the codex binaryPath", () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const nativeSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const fixtureRoot = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "cafe-provider-registry-reprobe-",
          });
          const isolatedCodexHome = path.join(fixtureRoot, "codex-home");
          const fixtureTemp = path.join(fixtureRoot, "tmp");
          yield* fileSystem.makeDirectory(isolatedCodexHome);
          yield* fileSystem.makeDirectory(fixtureTemp);
          const executableSuffix = process.platform === "win32" ? ".exe" : "";
          const firstMissing = path.join(fixtureRoot, `missing-first${executableSuffix}`);
          const secondMissing = path.join(fixtureRoot, `missing-second${executableSuffix}`);
          const spawnedBinaries: string[] = [];
          const rejectedFixtureOperations: string[] = [];
          const isFixturePath = (filePath: string) => {
            const relative = path.relative(fixtureRoot, path.resolve(filePath));
            return (
              relative === "" ||
              (!path.isAbsolute(relative) &&
                relative !== ".." &&
                !relative.startsWith(`..${path.sep}`))
            );
          };
          // A forgotten homePath can materialize the user's default auth
          // overlay before the missing executable is ever spawned. Refuse
          // that directory creation/enumeration, rather than discovering a
          // real profile mutation only after the snapshot assertions fail.
          const guardedFileSystem: FileSystem.FileSystem = {
            ...fileSystem,
            makeDirectory: (filePath, options) => {
              if (!isFixturePath(filePath)) {
                rejectedFixtureOperations.push("external-directory-create");
                return Effect.die(
                  new Error("Provider fixture attempted an external directory operation."),
                );
              }
              return fileSystem.makeDirectory(filePath, options);
            },
            readDirectory: (filePath, options) => {
              if (!isFixturePath(filePath)) {
                rejectedFixtureOperations.push("external-directory-read");
                return Effect.die(
                  new Error("Provider fixture attempted an external directory operation."),
                );
              }
              return fileSystem.readDirectory(filePath, options);
            },
          };
          const isolatedSpawnEnvironment: NodeJS.ProcessEnv = {
            HOME: fixtureRoot,
            HOMEDRIVE:
              process.platform === "win32"
                ? path.parse(fixtureRoot).root.slice(0, -1)
                : fixtureRoot,
            HOMEPATH:
              process.platform === "win32"
                ? fixtureRoot.slice(path.parse(fixtureRoot).root.length - 1)
                : fixtureRoot,
            USERPROFILE: fixtureRoot,
            APPDATA: path.join(fixtureRoot, "AppData", "Roaming"),
            LOCALAPPDATA: path.join(fixtureRoot, "AppData", "Local"),
            TEMP: fixtureTemp,
            TMP: fixtureTemp,
            TMPDIR: fixtureTemp,
            PATH: fixtureRoot,
            CODEX_HOME: isolatedCodexHome,
            CODEX_SQLITE_HOME: isolatedCodexHome,
            NODE_V8_COVERAGE: "",
          };
          // Only Windows' OS directory is inherited. ComSpec also points at
          // its system executable, without changing the production command's
          // native-versus-batch shell selection.
          const windowsSystemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
          if (process.platform === "win32") {
            assert.isString(
              windowsSystemRoot,
              "Windows system directory is required by the fixture.",
            );
            isolatedSpawnEnvironment.SystemRoot = windowsSystemRoot;
            isolatedSpawnEnvironment.WINDIR = windowsSystemRoot;
            isolatedSpawnEnvironment.ComSpec = path.join(windowsSystemRoot!, "System32", "cmd.exe");
            isolatedSpawnEnvironment.SYSTEMDRIVE = path.parse(windowsSystemRoot!).root.slice(0, -1);
            // libuv restores these required keys from the parent if absent,
            // even with an explicit env. Fixed values avoid inheriting the
            // host's domain identity or a network logon-server address.
            // Pinned Node's required_vars / make_program_env:
            // https://github.com/nodejs/node/blob/v24.13.1/deps/uv/src/win/process.c
            isolatedSpawnEnvironment.LOGONSERVER = "cafe-fixture";
            isolatedSpawnEnvironment.USERDOMAIN = "cafe-fixture";
            isolatedSpawnEnvironment.USERNAME = "cafe-fixture";
          }
          const guardedSpawner = ChildProcessSpawner.make((command) => {
            // This test qualifies registry reconciliation with real ENOENT
            // callbacks, not provider execution. Only its exact two absent
            // binaries and version argv may reach the native spawner. Clearing
            // extendEnv prevents Effect's ambient merge; explicit profile/temp
            // values and disabled V8 coverage prevent Node/libuv from filling
            // those omitted keys back in from the parent environment.
            if (
              command._tag !== "StandardCommand" ||
              (command.command !== firstMissing && command.command !== secondMissing) ||
              command.args.length !== 1 ||
              command.args[0] !== "--version" ||
              command.options.env?.CODEX_HOME !== isolatedCodexHome
            ) {
              rejectedFixtureOperations.push("unexpected-provider-spawn");
              return Effect.die(new Error("Unexpected provider process fixture request."));
            }
            spawnedBinaries.push(command.command);
            return nativeSpawner.spawn(
              ChildProcess.make(command.command, command.args, {
                ...command.options,
                cwd: fixtureRoot,
                env: isolatedSpawnEnvironment,
                extendEnv: false,
              }),
            );
          });
          const reprobeModel = "settings-reprobe-marker";
          const serverSettings = yield* makeMutableServerSettingsService(
            decodeServerSettings(
              deepMerge(encodedDefaultServerSettings, {
                providers: {
                  codex: { enabled: true, binaryPath: firstMissing, homePath: isolatedCodexHome },
                  claudeAgent: { enabled: false },
                },
              }),
            ),
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const providerRegistryLayer = ProviderRegistryLive.pipe(
            Layer.provideMerge(ProviderInstanceRegistryHydrationLive),
            Layer.provideMerge(Layer.succeed(ServerSettingsService, serverSettings)),
            Layer.provideMerge(
              ServerConfig.layerTest(fixtureRoot, path.join(fixtureRoot, "server")),
            ),
            Layer.provideMerge(TestHttpClientLive),
            Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
            Layer.provideMerge(OpenCodeRuntimeLive),
            Layer.provideMerge(
              Layer.mergeAll(
                NodeServices.layer,
                Layer.succeed(FileSystem.FileSystem, guardedFileSystem),
                Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, guardedSpawner),
              ),
            ),
          );
          const runtimeServices = yield* Layer.build(providerRegistryLayer).pipe(
            Scope.provide(scope),
          );
          const runtimeServicesWithMutator = runtimeServices as unknown as Context.Context<
            ProviderRegistry | ProviderInstanceRegistry | ProviderInstanceRegistryMutator
          >;

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry;
            const instanceRegistry = yield* ProviderInstanceRegistry;
            const codexInstanceId = ProviderInstanceId.make("codex");
            const initialInstance = yield* instanceRegistry.getInstance(codexInstanceId);
            assert.strictEqual(
              initialInstance?.continuationIdentity.continuationKey,
              `codex:home:${path.resolve(isolatedCodexHome)}`,
            );
            // Boot-time probe: the default codex instance is enabled with
            // `firstMissing`, so the real spawner yields ENOENT and the
            // snapshot should be `status: "error"` / `installed: false`.
            const initialProviders = yield* registry.getProviders;
            const initialCodex = initialProviders.find(
              (provider) => provider.instanceId === "codex",
            );
            assert.strictEqual(initialCodex?.status, "error");
            assert.strictEqual(initialCodex?.installed, false);
            assert.strictEqual(
              initialCodex?.models.some((model) => model.slug === reprobeModel),
              false,
            );
            yield* Effect.yieldNow;
            yield* TestClock.adjust("1 millis");
            yield* Effect.yieldNow;

            // Drive a settings change. The Hydration layer's
            // `SettingsWatcherLive` consumes this via `streamChanges`,
            // calls `reconcile`, which rebuilds the codex instance (the
            // envelope changed because `binaryPath` differs → `entryEqual`
            // is false). The registry's `Stream.runForEach(
            // instanceRegistry.streamChanges, () => syncLiveSources)`
            // fires `syncLiveSources`, which subscribes + awaits a fresh
            // refresh on the rebuilt instance.
            const nextSettings = yield* serverSettings.updateSettings({
              providers: {
                codex: {
                  enabled: true,
                  binaryPath: secondMissing,
                  homePath: isolatedCodexHome,
                  customModels: [reprobeModel],
                },
              },
            });
            const mutator = yield* ProviderInstanceRegistryMutator;
            yield* mutator.reconcile(deriveProviderInstanceConfigMap(nextSettings));

            // Poll with TestClock until the rebuilt probe reflects settings
            // from the new instance. The replacement binary is still missing,
            // but custom models are projected into error snapshots, so this
            // proves the aggregator no longer holds the initial snapshot.
            const refreshed = yield* Effect.gen(function* () {
              for (let attempts = 0; attempts < 120; attempts += 1) {
                const providers = yield* registry.getProviders;
                const codex = providers.find((provider) => provider.instanceId === "codex");
                if (
                  codex?.models.some((model) => model.slug === reprobeModel && model.isCustom) ===
                  true
                ) {
                  return providers;
                }
                yield* TestClock.adjust("50 millis");
                yield* Effect.yieldNow;
                if (process.platform === "win32") {
                  // The probe intentionally uses the real process spawner to
                  // observe ENOENT. Advancing TestClock cannot advance libuv's
                  // Windows process callback, so give that callback a bounded
                  // slice of wall time under the fully parallel CI workload.
                  yield* Effect.promise(
                    () => new Promise<void>((resolve) => setTimeout(resolve, 25)),
                  );
                }
              }
              return yield* registry.getProviders;
            });

            const reprobedCodex = refreshed.find((provider) => provider.instanceId === "codex");
            assert.strictEqual(reprobedCodex?.status, "error");
            assert.strictEqual(reprobedCodex?.installed, false);
            assert.strictEqual(
              reprobedCodex?.models.some((model) => model.slug === reprobeModel && model.isCustom),
              true,
              "Expected a fresh probe after settings change, got the stale snapshot",
            );
            const refreshedInstance = yield* instanceRegistry.getInstance(codexInstanceId);
            assert.strictEqual(
              refreshedInstance?.continuationIdentity.continuationKey,
              `codex:home:${path.resolve(isolatedCodexHome)}`,
            );
            assert.include(spawnedBinaries, firstMissing);
            assert.include(spawnedBinaries, secondMissing);
            assert.deepStrictEqual(rejectedFixtureOperations, []);
            assert.deepStrictEqual(yield* fileSystem.readDirectory(isolatedCodexHome), []);
          }).pipe(Effect.provide(runtimeServicesWithMutator));
        }),
      );

      it.effect("includes unavailable instance snapshots in getProviders", () =>
        Effect.gen(function* () {
          const serverSettings = yield* makeMutableServerSettingsService(
            decodeServerSettings(
              deepMerge(encodedDefaultServerSettings, {
                providers: {
                  codex: { enabled: false },
                  claudeAgent: { enabled: false },
                },
                providerInstances: {
                  ghost_main: {
                    driver: "ghostDriver",
                    displayName: "A fork-only driver we don't ship",
                    enabled: false,
                    config: { arbitrary: "payload" },
                  },
                } as unknown as ContractServerSettings["providerInstances"],
              }),
            ),
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const providerRegistryLayer = ProviderRegistryLive.pipe(
            Layer.provideMerge(ProviderInstanceRegistryHydrationLive),
            Layer.provideMerge(Layer.succeed(ServerSettingsService, serverSettings)),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-",
              }),
            ),
            Layer.provideMerge(TestHttpClientLive),
            Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
            Layer.provideMerge(OpenCodeRuntimeLive),
            Layer.provideMerge(NodeServices.layer),
          );
          const runtimeServices = yield* Layer.build(providerRegistryLayer).pipe(
            Scope.provide(scope),
          );

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry;
            const providers = yield* registry.getProviders;
            const ghost = providers.find((provider) => provider.instanceId === "ghost_main");

            assert.notStrictEqual(ghost, undefined);
            assert.strictEqual(ghost?.driver, "ghostDriver");
            assert.strictEqual(ghost?.availability, "unavailable");
            assert.match(ghost?.unavailableReason ?? "", /ghostDriver/);
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      it.effect("skips codex probes entirely when the provider is disabled", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexProviderStatus(disabledCodexSettings).pipe(
            Effect.provide(failingSpawnerLayer("spawn codex ENOENT")),
          );
          assert.strictEqual(status.enabled, false);
          assert.strictEqual(status.status, "disabled");
          assert.strictEqual(status.installed, false);
          assert.strictEqual(status.message, "Codex is disabled in Cafe Code settings.");
        }),
      );
    });

    describe("checkCodexCliProviderStatus", () => {
      it.effect("explains missing native Codex dependencies without exposing launcher output", () =>
        Effect.gen(function* () {
          // The same launcher failure can occur on any official platform and
          // some command wrappers forward stderr to stdout. All variants must
          // remain a version-phase failure, never an account/login failure.
          for (const target of [
            "darwin-arm64",
            "darwin-x64",
            "linux-arm64",
            "linux-x64",
            "win32-arm64",
            "win32-x64",
          ]) {
            for (const outputChannel of ["stderr", "stdout"] as const) {
              const output =
                "file:///private/user/provider-install/bin/codex.js:107\n" +
                `Error: Missing optional dependency @openai/codex-${target}. ` +
                "Reinstall Codex: untrusted-provider-command\n" +
                "    at findCodexExecutable (file:///private/user/provider-install/bin/codex.js:107:9)\n" +
                "private-secret-sentinel\nNode.js v25.9.0\n";
              const { layer, commands } = recordingMockSpawnerLayer(() => ({
                stdout: outputChannel === "stdout" ? output : "",
                stderr: outputChannel === "stderr" ? output : "",
                code: 1,
              }));
              const status = yield* checkCodexCliProviderStatus(
                defaultCodexSettings,
                isolatedCodexProbeEnvironment,
              ).pipe(Effect.provide(layer));

              assert.strictEqual(status.installed, true);
              assert.strictEqual(status.status, "error");
              assert.strictEqual(status.version, null);
              assert.deepStrictEqual(status.auth, { status: "unknown" });
              assert.strictEqual(
                status.message,
                "Codex's installation is incomplete: its native executable is missing. Reinstall Codex with optional dependencies enabled, or choose a working Codex binary in provider settings. Account authentication could not be checked.",
              );
              assert.deepStrictEqual(
                commands.map((command) => command.args),
                [["--version"]],
              );
              const serialized = JSON.stringify(status);
              for (const privateDetail of [
                "/private/user",
                "untrusted-provider-command",
                "private-secret-sentinel",
                "25.9.0",
              ]) {
                assert.notInclude(serialized, privateDetail);
              }
            }
          }
        }),
      );

      it.effect("does not classify unrelated missing packages as a native Codex dependency", () =>
        Effect.gen(function* () {
          for (const detail of [
            "Missing optional dependency @openai/codex-darwin-arm64-unrelated.",
            "Unknown launcher failure with private-secret-sentinel at /private/user/provider-install; Node.js v25.9.0",
          ]) {
            const status = yield* checkCodexCliProviderStatus(
              defaultCodexSettings,
              isolatedCodexProbeEnvironment,
            ).pipe(
              Effect.provide(mockSpawnerLayer(() => ({ stdout: detail, stderr: detail, code: 1 }))),
            );
            assert.strictEqual(status.status, "error");
            assert.strictEqual(status.version, null);
            assert.strictEqual(
              status.message,
              "Codex CLI is installed but failed to run. Check its installation and the binary selected in provider settings.",
            );
            assert.notInclude(JSON.stringify(status), detail);
          }
        }),
      );

      it.effect("does not expose a failed version probe's spawn exception", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexCliProviderStatus(
            defaultCodexSettings,
            isolatedCodexProbeEnvironment,
          ).pipe(
            Effect.provide(
              Layer.succeed(
                ChildProcessSpawner.ChildProcessSpawner,
                ChildProcessSpawner.make(() =>
                  Effect.fail(
                    PlatformError.systemError({
                      _tag: "PermissionDenied",
                      module: "ChildProcess",
                      method: "spawn",
                      description: "private-secret-sentinel at /private/user/provider-install",
                    }),
                  ),
                ),
              ),
            ),
          );
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.version, null);
          assert.strictEqual(
            status.message,
            "Failed to execute the Codex CLI health check. Check the binary selected in provider settings.",
          );
          assert.notInclude(JSON.stringify(status), "private-secret-sentinel");
          assert.notInclude(JSON.stringify(status), "/private/user");
        }),
      );

      it("classifies only the bounded login-status timeout as inconclusive", () => {
        const timeoutSnapshot = {
          instanceId: ProviderInstanceId.make("codex"),
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          installed: true,
          version: "0.133.0",
          status: "warning",
          auth: { status: "unknown" },
          checkedAt: "2026-04-10T00:00:00.000Z",
          message: CODEX_CLI_LOGIN_STATUS_TIMEOUT_MESSAGE,
          models: [],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;

        assert.isTrue(isCodexCliLoginStatusProbeInconclusive(timeoutSnapshot));
        assert.isFalse(
          isCodexCliLoginStatusProbeInconclusive({
            ...timeoutSnapshot,
            status: "error",
            auth: { status: "unauthenticated" },
            message: "Codex CLI is not authenticated.",
          }),
        );
      });

      it.effect("uses the Codex CLI login status path for lightweight provider status", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexCliProviderStatus(
            defaultCodexSettings,
            isolatedCodexProbeEnvironment,
          ).pipe(
            Effect.provide(
              mockSpawnerLayer((args) => {
                const joined = args.join(" ");
                if (joined === "--version") {
                  return { stdout: "codex-cli 0.153.4\n", stderr: "", code: 0 };
                }
                if (joined === "login status") {
                  return { stdout: "", stderr: "Logged in using ChatGPT\n", code: 0 };
                }
                throw new Error(`Unexpected args: ${joined}`);
              }),
            ),
          );

          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.version, "0.153.4");
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "chatgpt");
          assert.strictEqual(status.auth.label, "ChatGPT Subscription");
          assert.deepStrictEqual(
            status.models.map((model) => model.slug),
            [
              "gpt-6-astra",
              "gpt-6.1-sol",
              "gpt-6-sol",
              "gpt-6-luna",
              "gpt-5.6-sol",
              "gpt-5.6-terra",
              "gpt-5.6-luna",
              "gpt-5.5",
              "gpt-5.4",
              "gpt-5.4-mini",
              "gpt-5.3-codex-spark",
            ],
          );
          const reasoningDescriptor = (slug: string) => {
            const descriptor = status.models
              .find((model) => model.slug === slug)
              ?.capabilities?.optionDescriptors?.find(
                (candidate) => candidate.id === "reasoningEffort",
              );
            if (!descriptor || descriptor.type !== "select") {
              throw new Error(`Missing reasoning descriptor for ${slug}`);
            }
            return descriptor;
          };
          const hasFastMode = (slug: string) =>
            status.models
              .find((model) => model.slug === slug)
              ?.capabilities?.optionDescriptors?.some(
                (descriptor) => descriptor.id === "fastMode" && descriptor.type === "boolean",
              ) === true;

          assert.deepStrictEqual(
            reasoningDescriptor("gpt-5.6-sol").options.map((option) => option.id),
            ["low", "medium", "high", "xhigh", "max", "ultra"],
          );
          assert.strictEqual(reasoningDescriptor("gpt-5.6-sol").currentValue, "low");
          assert.deepStrictEqual(
            reasoningDescriptor("gpt-5.6-terra").options.map((option) => option.id),
            ["low", "medium", "high", "xhigh", "max", "ultra"],
          );
          assert.strictEqual(reasoningDescriptor("gpt-5.6-terra").currentValue, "medium");
          assert.deepStrictEqual(
            reasoningDescriptor("gpt-5.6-luna").options.map((option) => option.id),
            ["low", "medium", "high", "xhigh", "max"],
          );
          assert.strictEqual(reasoningDescriptor("gpt-5.6-luna").currentValue, "medium");
          assert.equal(
            status.models.some((model) => model.slug === "gpt-daybreak-blue-latest"),
            false,
          );
          assert.equal(
            status.models.some((model) =>
              model.capabilities?.optionDescriptors?.some(
                (descriptor) => descriptor.id === "cyberAccessProgram",
              ),
            ),
            false,
          );
          assert.strictEqual(hasFastMode("gpt-5.6-sol"), true);
          assert.strictEqual(hasFastMode("gpt-5.6-terra"), true);
          assert.strictEqual(hasFastMode("gpt-5.6-luna"), true);
          assert.deepStrictEqual(status.skills, []);
        }),
      );

      it.effect("adds the Codex auth email from the local auth token metadata", () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const homePath = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "cafecode-codex-auth-email-",
          });
          const authPath = path.join(homePath, "auth.json");
          yield* fileSystem.writeFileString(
            authPath,
            encodeUnknownJsonString({
              auth_mode: "chatgpt",
              tokens: {
                id_token: makeUnsignedJwt({
                  email: "codex-user@example.com",
                  email_verified: true,
                }),
              },
            }),
          );
          yield* fileSystem.chmod(authPath, 0o600);

          const status = yield* checkCodexCliProviderStatus(
            decodeCodexSettings({ homePath }),
            isolatedCodexProbeEnvironment,
          ).pipe(
            Effect.provide(
              mockSpawnerLayer((args) => {
                const joined = args.join(" ");
                if (joined === "--version") {
                  return { stdout: "codex-cli 0.133.0\n", stderr: "", code: 0 };
                }
                if (joined === "login status") {
                  return { stdout: "Logged in using ChatGPT\n", stderr: "", code: 0 };
                }
                throw new Error(`Unexpected args: ${joined}`);
              }),
            ),
          );

          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "chatgpt");
          assert.strictEqual(status.auth.label, "ChatGPT Subscription");
          assert.strictEqual(status.auth.email, "codex-user@example.com");
        }),
      );

      it.effect("labels subscription plans from the existing lightweight usage request only", () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const homePath = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "cafecode-codex-subscription-",
          });
          const authPath = path.join(homePath, "auth.json");
          // Synthetic credentials keep this test isolated from the developer's
          // account. The only HTTP request is intercepted below; no provider
          // process or model inference is permitted by the recording fake.
          yield* fileSystem.writeFileString(
            authPath,
            encodeUnknownJsonString({
              auth_mode: "chatgpt",
              tokens: {
                access_token: "subscription-fixture-token",
                account_id: "subscription-fixture-account",
              },
            }),
          );
          yield* fileSystem.chmod(authPath, 0o600);
          const originalFetch = globalThis.fetch;
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              globalThis.fetch = originalFetch;
            }),
          );

          for (const testCase of [
            { plan: "plus", label: "ChatGPT Plus Subscription" },
            { plan: "prolite", label: "ChatGPT Pro 100 Subscription" },
            { plan: "pro", label: "ChatGPT Pro 200 Subscription" },
            { plan: "promax", label: "ChatGPT Pro 500 Subscription" },
            { plan: undefined, label: "ChatGPT Subscription" },
            { plan: null, label: "ChatGPT Subscription" },
            { plan: "unknown", label: "ChatGPT Subscription" },
            { plan: "unrecognized-plan", label: "ChatGPT Subscription" },
          ]) {
            let fetchCount = 0;
            globalThis.fetch = (async () => {
              fetchCount += 1;
              return Response.json({
                ...(testCase.plan !== undefined ? { plan_type: testCase.plan } : {}),
                rate_limit: { primary_window: { used_percent: 10 } },
              });
            }) as typeof fetch;
            const { layer, commands } = recordingMockSpawnerLayer((args) => {
              const command = args.join(" ");
              if (command === "--version") {
                return { stdout: "codex-cli 0.153.4\n", stderr: "", code: 0 };
              }
              if (command === "login status") {
                return { stdout: "Logged in using ChatGPT\n", stderr: "", code: 0 };
              }
              throw new Error(`Unexpected subscription probe: ${command}`);
            });
            const status = yield* checkCodexCliProviderStatus(
              decodeCodexSettings({ homePath }),
              isolatedCodexProbeEnvironment,
            ).pipe(Effect.provide(layer));
            assert.strictEqual(status.auth.label, testCase.label);
            assert.strictEqual(status.auth.status, "authenticated");
            assert.strictEqual(fetchCount, 1);
            assert.deepStrictEqual(
              commands.map((command) => command.args.join(" ")),
              ["--version", "login status"],
            );
          }

          // Even if old ChatGPT credentials exist on disk, a current API-key or
          // unauthenticated login result must not request or display their tier.
          for (const testCase of [
            {
              login: "Logged in using an API key - synthetic-key",
              code: 0,
              label: "OpenAI API Key",
              auth: "authenticated",
            },
            { login: "Not logged in", code: 1, label: undefined, auth: "unauthenticated" },
          ]) {
            let fetchCount = 0;
            globalThis.fetch = (async () => {
              fetchCount += 1;
              return Response.json({ plan_type: "promax" });
            }) as typeof fetch;
            const status = yield* checkCodexCliProviderStatus(
              decodeCodexSettings({ homePath }),
              isolatedCodexProbeEnvironment,
            ).pipe(
              Effect.provide(
                mockSpawnerLayer((args) => {
                  const command = args.join(" ");
                  if (command === "--version") {
                    return { stdout: "codex-cli 0.153.4\n", stderr: "", code: 0 };
                  }
                  if (command === "login status") {
                    return { stdout: testCase.login, stderr: "", code: testCase.code };
                  }
                  throw new Error(`Unexpected subscription probe: ${command}`);
                }),
              ),
            );
            assert.strictEqual(status.auth.label, testCase.label);
            assert.strictEqual(status.auth.status, testCase.auth);
            assert.strictEqual(fetchCount, 0);
          }
        }),
      );

      it.effect("adds redacted Codex account usage from the upstream ChatGPT usage endpoint", () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const homePath = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "cafecode-codex-rate-limits-",
          });
          const authPath = path.join(homePath, "auth.json");
          yield* fileSystem.writeFileString(
            authPath,
            encodeUnknownJsonString({
              auth_mode: "chatgpt",
              tokens: {
                id_token: makeUnsignedJwt({
                  email: "codex-user@example.com",
                  "https://api.openai.com/auth": {
                    chatgpt_account_id: "account-id",
                    chatgpt_account_is_fedramp: true,
                  },
                }),
                access_token: "access-token",
                refresh_token: "refresh-token",
                account_id: "account-id",
              },
            }),
          );
          yield* fileSystem.chmod(authPath, 0o600);

          const originalFetch = globalThis.fetch;
          const seenHeaders: Array<Record<string, string>> = [];
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              globalThis.fetch = originalFetch;
            }),
          );
          globalThis.fetch = (async (
            _input: Parameters<typeof fetch>[0],
            init: Parameters<typeof fetch>[1],
          ) => {
            seenHeaders.push(init?.headers as Record<string, string>);
            return Response.json({
              plan_type: "pro",
              normal_model_slug: null,
              rate_limit_reached_type: { kind: "workspace_owner_usage_limit_reached" },
              rate_limit: {
                primary_window: {
                  used_percent: 25,
                  limit_window_seconds: 18_000,
                  reset_at: 1_780_000_000,
                },
                secondary_window: {
                  used_percent: 75,
                  limit_window_seconds: 604_800,
                  reset_at: 1_780_100_000,
                },
              },
              credits: {
                has_credits: true,
                unlimited: false,
                balance: "9.99",
              },
              spend_control: {
                reached: true,
                individual_limit: {
                  limit: "100.00",
                  remaining_percent: 0,
                  reset_at: 1_780_200_000,
                  used: "100.00",
                },
              },
              rate_limit_reset_credits: {
                available_count: 2,
                credits: [
                  {
                    id: "credit-1",
                    reset_type: "codex_rate_limits",
                    status: "available",
                    granted_at: 1_780_000_010,
                    expires_at: 1_780_100_010,
                    title: "Rate limit reset",
                    description: "Reset Codex usage windows.",
                  },
                ],
              },
              additional_rate_limits: [
                {
                  limit_name: "Spark",
                  metered_feature: "codex_bengalfox",
                  normal_model_slug: "gpt-5.6-luna",
                  credits: { has_credits: false, unlimited: false, balance: "0" },
                  rate_limit_reached_type: "workspace_member_credits_depleted",
                  rate_limit: {
                    primary_window: {
                      used_percent: 10,
                      limit_window_seconds: 3_600,
                      reset_at: 1_780_000_100,
                    },
                  },
                },
                {
                  limitName: "Unavailable quota metadata",
                  meteredFeature: "unavailable",
                  normalModelSlug: null,
                  credits: null,
                  rateLimitReachedType: null,
                  rateLimit: { primary: { usedPercent: 0 } },
                },
                {
                  limit_name: "Omitted quota metadata",
                  metered_feature: "omitted",
                  rate_limit: { primary_window: { used_percent: 0 } },
                },
                {
                  limit_name: "Literal record key",
                  metered_feature: "__proto__",
                  normal_model_slug: "gpt-6-sol",
                },
              ],
            });
          }) as typeof fetch;

          const status = yield* checkCodexCliProviderStatus(
            decodeCodexSettings({ homePath }),
            isolatedCodexProbeEnvironment,
          ).pipe(
            Effect.provide(
              mockSpawnerLayer((args) => {
                const joined = args.join(" ");
                if (joined === "--version") {
                  return { stdout: "codex-cli 0.134.0\n", stderr: "", code: 0 };
                }
                if (joined === "login status") {
                  return { stdout: "Logged in using ChatGPT\n", stderr: "", code: 0 };
                }
                throw new Error(`Unexpected args: ${joined}`);
              }),
            ),
          );

          assert.strictEqual(seenHeaders[0]?.authorization, "Bearer access-token");
          assert.strictEqual(seenHeaders[0]?.["ChatGPT-Account-ID"], "account-id");
          assert.strictEqual(seenHeaders[0]?.["X-OpenAI-Fedramp"], "true");
          assert.strictEqual(status.accountRateLimits?.rateLimits.planType, "pro");
          assert.strictEqual(status.accountRateLimits?.rateLimits.normalModelSlug, null);
          assert.strictEqual(
            status.accountRateLimits?.rateLimits.rateLimitReachedType,
            "workspace_owner_usage_limit_reached",
          );
          assert.deepStrictEqual(status.accountRateLimits?.rateLimits.credits, {
            hasCredits: true,
            unlimited: false,
            balance: "9.99",
          });
          assert.strictEqual(status.auth.label, "ChatGPT Pro 200 Subscription");
          assert.strictEqual(status.accountRateLimits?.rateLimits.primary?.windowDurationMins, 300);
          assert.strictEqual(status.accountRateLimits?.rateLimits.secondary?.usedPercent, 75);
          assert.strictEqual(status.accountRateLimits?.rateLimits.spendControlReached, true);
          assert.deepStrictEqual(status.accountRateLimits?.rateLimits.individualLimit, {
            limit: "100.00",
            remainingPercent: 0,
            resetsAt: 1_780_200_000,
            used: "100.00",
          });
          assert.strictEqual(status.accountRateLimits?.rateLimitResetCredits?.availableCount, 2);
          assert.deepStrictEqual(status.accountRateLimits?.rateLimitResetCredits?.credits, [
            {
              id: "credit-1",
              resetType: "codexRateLimits",
              status: "available",
              grantedAt: 1_780_000_010,
              expiresAt: 1_780_100_010,
              title: "Rate limit reset",
              description: "Reset Codex usage windows.",
            },
          ]);
          assert.strictEqual(
            status.accountRateLimits?.rateLimitsByLimitId?.codex_bengalfox?.primary
              ?.windowDurationMins,
            60,
          );
          assert.strictEqual(
            status.accountRateLimits?.rateLimitsByLimitId?.codex_bengalfox?.normalModelSlug,
            "gpt-5.6-luna",
          );
          assert.deepStrictEqual(
            status.accountRateLimits?.rateLimitsByLimitId?.codex_bengalfox?.credits,
            {
              hasCredits: false,
              unlimited: false,
              balance: "0",
            },
          );
          assert.strictEqual(
            status.accountRateLimits?.rateLimitsByLimitId?.codex_bengalfox?.rateLimitReachedType,
            "workspace_member_credits_depleted",
          );
          assert.deepStrictEqual(status.accountRateLimits?.rateLimitsByLimitId?.unavailable, {
            limitId: "unavailable",
            limitName: "Unavailable quota metadata",
            normalModelSlug: null,
            credits: null,
            rateLimitReachedType: null,
            planType: "pro",
            primary: { usedPercent: 0 },
          });
          assert.deepStrictEqual(status.accountRateLimits?.rateLimitsByLimitId?.omitted, {
            limitId: "omitted",
            limitName: "Omitted quota metadata",
            planType: "pro",
            primary: { usedPercent: 0 },
          });
          const namedQuotas = status.accountRateLimits?.rateLimitsByLimitId;
          assert.ok(namedQuotas);
          assert.strictEqual(Object.hasOwn(namedQuotas, "__proto__"), true);
          assert.strictEqual(Object.getPrototypeOf(namedQuotas), Object.prototype);
          assert.deepStrictEqual(namedQuotas["__proto__"], {
            limitId: "__proto__",
            limitName: "Literal record key",
            normalModelSlug: "gpt-6-sol",
            planType: "pro",
          });
          const encodedStatus = encodeUnknownJsonString(status);
          assert.strictEqual(encodedStatus.includes("access-token"), false);
          assert.strictEqual(encodedStatus.includes("refresh-token"), false);
          assert.strictEqual(encodedStatus.includes("account-id"), false);
        }),
      );

      it.effect(
        "preserves nested WHAM spend controls without borrowing legacy or other bucket values",
        () =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const homePath = yield* fileSystem.makeTempDirectoryScoped({
              prefix: "cafecode-codex-spend-control-",
            });
            const authPath = path.join(homePath, "auth.json");
            yield* fileSystem.writeFileString(
              authPath,
              encodeUnknownJsonString({
                auth_mode: "chatgpt",
                tokens: { access_token: "synthetic-spend-control-token" },
              }),
            );
            yield* fileSystem.chmod(authPath, 0o600);
            const originalFetch = globalThis.fetch;
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                globalThis.fetch = originalFetch;
              }),
            );

            const nativeLimit = {
              limit: "100.00",
              used: "0",
              remaining_percent: 0,
              reset_at: 0,
              // Only supported metadata may leave this HTTP boundary.
              private_extension: "must-not-survive",
            };
            const expectedLimit = {
              limit: "100.00",
              used: "0",
              remainingPercent: 0,
              resetsAt: 0,
            };
            const legacyLimit = {
              limit: "100.00",
              used: "0",
              remaining_percent: 0,
              resets_at: 0,
            };
            const cases = [
              {
                label: "native false and zero override flattened values",
                payload: {
                  spend_control: { reached: false, individual_limit: nativeLimit },
                  spend_control_reached: true,
                  individual_limit: null,
                },
                expected: { spendControlReached: false, individualLimit: expectedLimit },
              },
              {
                label: "null native container overrides stale flattened fields",
                payload: {
                  spend_control: null,
                  spend_control_reached: true,
                  individual_limit: legacyLimit,
                  spendControl: { reached: true, individualLimit: legacyLimit },
                },
                expected: { spendControlReached: null, individualLimit: null },
              },
              {
                label: "null native fields never fall through to legacy spellings",
                payload: {
                  spend_control: {
                    reached: null,
                    individual_limit: null,
                    individualLimit: legacyLimit,
                  },
                  spend_control_reached: true,
                  individual_limit: legacyLimit,
                },
                expected: { spendControlReached: null, individualLimit: null },
              },
              {
                label: "legacy flattened snake case remains compatible",
                payload: { spend_control_reached: false, individual_limit: legacyLimit },
                expected: { spendControlReached: false, individualLimit: expectedLimit },
              },
              {
                label: "legacy flattened camel case remains compatible",
                payload: { spendControlReached: false, individualLimit: expectedLimit },
                expected: { spendControlReached: false, individualLimit: expectedLimit },
              },
              {
                label: "legacy rate-limit-local fields remain compatible",
                payload: {
                  rate_limit: { spend_control_reached: false, individual_limit: legacyLimit },
                },
                expected: { spendControlReached: false, individualLimit: expectedLimit },
              },
              {
                label: "flattened null overrides legacy rate-limit-local fields",
                payload: {
                  spend_control_reached: null,
                  spendControlReached: true,
                  individual_limit: null,
                  individualLimit: legacyLimit,
                  rate_limit: { spend_control_reached: true, individual_limit: legacyLimit },
                },
                expected: { spendControlReached: null, individualLimit: null },
              },
              {
                label: "malformed native container does not revive legacy values",
                payload: {
                  spend_control: [],
                  spend_control_reached: true,
                  individual_limit: legacyLimit,
                },
                expected: {},
              },
              {
                label: "missing native fields do not revive legacy values",
                payload: {
                  spend_control: {},
                  spend_control_reached: true,
                  individual_limit: legacyLimit,
                },
                expected: {},
              },
              ...[
                { remaining_percent: "0" },
                { remaining_percent: null, remainingPercent: 20 },
                { reset_at: null, resets_at: 20 },
                { reset_at: -1 },
                { reset_at: 0.5 },
                { reset_at: Number.MAX_SAFE_INTEGER + 1 },
                { limit: "x".repeat(257) },
                { used: "" },
              ].map((invalidLimit) => ({
                label: `reject malformed spend limit ${encodeUnknownJsonString(invalidLimit)}`,
                payload: {
                  spend_control: {
                    reached: "false",
                    individual_limit: { ...nativeLimit, ...invalidLimit },
                  },
                },
                expected: {},
              })),
            ];
            const checkedAt = "2026-09-29T00:00:00.000Z";
            for (const testCase of cases) {
              globalThis.fetch = (async () =>
                Response.json({
                  ...testCase.payload,
                  additional_rate_limits: [
                    { metered_feature: "unspecified" },
                    {
                      metered_feature: "explicit",
                      spend_control: { reached: false, individual_limit: nativeLimit },
                    },
                  ],
                })) as typeof fetch;
              const usage = yield* readCodexAccountRateLimits(
                decodeCodexSettings({ homePath }),
                {},
                checkedAt,
              );
              assert.deepStrictEqual(
                usage?.rateLimits,
                { limitId: "codex", ...testCase.expected },
                testCase.label,
              );
              assert.deepStrictEqual(
                usage?.rateLimitsByLimitId?.unspecified,
                { limitId: "unspecified" },
                testCase.label,
              );
              assert.deepStrictEqual(
                usage?.rateLimitsByLimitId?.explicit,
                {
                  limitId: "explicit",
                  spendControlReached: false,
                  individualLimit: expectedLimit,
                },
                testCase.label,
              );
            }
          }),
      );

      it.effect("ignores Codex auth metadata when the auth file is a symlink", (context) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const homePath = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "cafecode-codex-auth-symlink-home-",
          });
          const targetPath = path.join(
            yield* fileSystem.makeTempDirectoryScoped({
              prefix: "cafecode-codex-auth-symlink-target-",
            }),
            "auth.json",
          );
          yield* fileSystem.writeFileString(
            targetPath,
            encodeUnknownJsonString({
              auth_mode: "chatgpt",
              tokens: {
                id_token: makeUnsignedJwt({
                  email: "unsafe-symlink@example.com",
                  email_verified: true,
                }),
              },
            }),
          );
          yield* fileSystem.symlink(targetPath, path.join(homePath, "auth.json")).pipe(
            Effect.catch((error) => {
              const cause = error.reason.cause;
              // This test has one invariant: real symlinked auth material must
              // never supply account metadata. Windows may deny creating that
              // fixture without Developer Mode or administrator privileges.
              // Inspect the original OS code rather than treating every Effect
              // permission/Unknown error as an unavailable symlink capability.
              // Scoped fixture directories still retire on the skipped path.
              if (
                process.platform === "win32" &&
                cause instanceof Error &&
                "code" in cause &&
                cause.code === "EPERM"
              ) {
                return Effect.sync(() =>
                  context.skip("Windows does not permit this auth-file symlink fixture."),
                );
              }
              return Effect.fail(error);
            }),
          );

          const status = yield* checkCodexCliProviderStatus(
            decodeCodexSettings({ homePath }),
            isolatedCodexProbeEnvironment,
          ).pipe(
            Effect.provide(
              mockSpawnerLayer((args) => {
                const joined = args.join(" ");
                if (joined === "--version") {
                  return { stdout: "codex-cli 0.133.0\n", stderr: "", code: 0 };
                }
                if (joined === "login status") {
                  return { stdout: "Logged in using ChatGPT\n", stderr: "", code: 0 };
                }
                throw new Error(`Unexpected args: ${joined}`);
              }),
            ),
          );

          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.email, undefined);
        }),
      );

      it.effect("passes the effective CODEX_HOME to every Codex CLI status command", () =>
        Effect.gen(function* () {
          const { layer, commands } = recordingMockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") {
              return { stdout: "codex-cli 0.133.0\n", stderr: "", code: 0 };
            }
            if (joined === "login status") {
              return { stdout: "Logged in using ChatGPT\n", stderr: "", code: 0 };
            }
            throw new Error(`Unexpected args: ${joined}`);
          });
          const fileSystem = yield* FileSystem.FileSystem;
          const homePath = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "cafecode-codex-status-home-",
          });

          const status = yield* checkCodexCliProviderStatus(
            decodeCodexSettings({ homePath }),
            isolatedCodexProbeEnvironment,
          ).pipe(Effect.provide(layer));

          assert.strictEqual(status.status, "ready");
          assert.deepStrictEqual(
            commands.map((command) => command.args.join(" ")),
            ["--version", "login status"],
          );
          assert.deepStrictEqual(
            commands.map((command) => command.env?.CODEX_HOME),
            [homePath, homePath],
          );
        }),
      );

      it.effect("returns unauthenticated when Codex CLI reports not logged in", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexCliProviderStatus(
            defaultCodexSettings,
            isolatedCodexProbeEnvironment,
          ).pipe(
            Effect.provide(
              mockSpawnerLayer((args) => {
                const joined = args.join(" ");
                if (joined === "--version") {
                  return { stdout: "codex-cli 0.133.0\n", stderr: "", code: 0 };
                }
                if (joined === "login status") {
                  return { stdout: "", stderr: "Not logged in\n", code: 1 };
                }
                throw new Error(`Unexpected args: ${joined}`);
              }),
            ),
          );

          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.version, "0.133.0");
          assert.strictEqual(status.auth.status, "unauthenticated");
          assert.strictEqual(
            status.message,
            "Codex CLI is not authenticated. Run `codex login` and try again.",
          );
        }),
      );
    });

    // ── checkClaudeProviderStatus tests ──────────────────────────

    describe("checkClaudeProviderStatus", () => {
      it.effect("rejects failed version output as native concurrency evidence", () =>
        Effect.gen(function* () {
          const calls: string[] = [];
          let capabilityProbeCalls = 0;
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            () =>
              Effect.sync(() => {
                capabilityProbeCalls += 1;
                return undefined;
              }),
            {},
          ).pipe(
            Effect.provide(
              mockSpawnerLayer((args) => {
                calls.push(args.join(" "));
                return {
                  stdout: "2.1.288\n",
                  stderr: "synthetic-private-version-failure-marker",
                  code: 1,
                };
              }),
            ),
          );
          assert.strictEqual(supportsSubagentConcurrency("claudeAgent", status.version), false);
          assert.strictEqual(status.version, null);
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.auth.status, "unknown");
          assert.strictEqual(capabilityProbeCalls, 0);
          assert.deepStrictEqual(calls, ["--version"]);
        }),
      );

      it.effect("does not publish failed version stdout or stderr as repair guidance", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            undefined,
            {},
          ).pipe(
            Effect.provide(
              mockSpawnerLayer(() => ({
                stdout: "Node.js 24.21.0 synthetic-private-stdout-marker\n",
                stderr: "dependency 2.1.288 synthetic-private-stderr-marker\n",
                code: 1,
              })),
            ),
          );
          assert.strictEqual(
            status.message,
            "Claude Agent CLI is installed but failed to run. Check its installation and the binary selected in provider settings.",
          );
          assert.notInclude(JSON.stringify(status), "synthetic-private-");
          assert.strictEqual(status.version, null);
          assert.strictEqual(supportsSubagentConcurrency("claudeAgent", status.version), false);
        }),
      );

      it.effect("returns ready when claude is installed and authenticated", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities(),
          );
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.auth.status, "authenticated");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("reports needs-login when the adapter has observed a Claude auth failure", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities(),
            undefined,
            Effect.succeed(true),
          );
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.auth.status, "unauthenticated");
          // Authentication loss does not revoke independently successful native
          // version evidence. The support bit is not proof of authentication.
          assert.strictEqual(status.version, "2.1.288");
          assert.strictEqual(supportsSubagentConcurrency("claudeAgent", status.version), true);
          assert.include(String(status.message), "/login");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "2.1.288\n", stderr: "", code: 0 };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it("maps Claude models across version gates without provider probes", () => {
        const cases = [
          {
            version: "2.1.110",
            slugs: [] as Array<string>,
            upgrade:
              "Claude Code v2.1.110 is too old for Claude Opus 5.5. Upgrade to v2.1.280 or newer to access it.",
          },
          { version: "2.1.111", slugs: ["claude-opus-4-7"] },
          { version: "2.1.154", slugs: ["claude-opus-4-7", "claude-opus-4-8"] },
          { version: "2.1.170", slugs: ["claude-opus-4-7", "claude-opus-4-8", "claude-fable-5"] },
          {
            version: "2.1.197",
            slugs: ["claude-opus-4-7", "claude-opus-4-8", "claude-fable-5", "claude-sonnet-5"],
          },
          {
            version: "2.1.218",
            slugs: ["claude-opus-4-7", "claude-opus-4-8", "claude-fable-5", "claude-sonnet-5"],
          },
          {
            version: "2.1.219",
            slugs: [
              "claude-opus-5",
              "claude-opus-4-7",
              "claude-opus-4-8",
              "claude-fable-5",
              "claude-sonnet-5",
            ],
          },
          {
            version: "2.1.256",
            slugs: [
              "claude-opus-5",
              "claude-opus-4-7",
              "claude-opus-4-8",
              "claude-fable-5",
              "claude-sonnet-5",
            ],
            upgrade:
              "Claude Code v2.1.256 is too old for Claude Opus 5.5. Upgrade to v2.1.280 or newer to access it.",
          },
          {
            version: "2.1.257",
            slugs: [
              "claude-opus-5",
              "claude-fable-5-1",
              "claude-opus-4-7",
              "claude-opus-4-8",
              "claude-fable-5",
              "claude-sonnet-5",
            ],
          },
          {
            version: "2.1.279",
            slugs: [
              "claude-opus-5",
              "claude-fable-5-1",
              "claude-opus-4-7",
              "claude-opus-4-8",
              "claude-fable-5",
              "claude-sonnet-5",
            ],
            upgrade:
              "Claude Code v2.1.279 is too old for Claude Opus 5.5. Upgrade to v2.1.280 or newer to access it.",
          },
          {
            version: "2.1.280",
            slugs: [
              "claude-opus-5-5",
              "claude-opus-5",
              "claude-fable-5-1",
              "claude-opus-4-7",
              "claude-opus-4-8",
              "claude-fable-5",
              "claude-sonnet-5",
            ],
            upgrade:
              "Claude Code v2.1.280 is too old for Claude Sonnet 5.5. Upgrade to v2.1.284 or newer to access it.",
          },
          {
            version: "2.1.283",
            slugs: [
              "claude-opus-5-5",
              "claude-opus-5",
              "claude-fable-5-1",
              "claude-opus-4-7",
              "claude-opus-4-8",
              "claude-fable-5",
              "claude-sonnet-5",
            ],
            upgrade:
              "Claude Code v2.1.283 is too old for Claude Sonnet 5.5. Upgrade to v2.1.284 or newer to access it.",
          },
          {
            version: "2.1.284",
            slugs: [
              "claude-opus-5-5",
              "claude-opus-5",
              "claude-fable-5-1",
              "claude-opus-4-7",
              "claude-opus-4-8",
              "claude-fable-5",
              "claude-sonnet-5-5",
              "claude-sonnet-5",
            ],
          },
        ];
        const gatedSlugs = [
          "claude-opus-5-5",
          "claude-opus-5",
          "claude-fable-5-1",
          "claude-opus-4-7",
          "claude-opus-4-8",
          "claude-fable-5",
          "claude-sonnet-5-5",
          "claude-sonnet-5",
        ];

        for (const testCase of cases) {
          const models = getBuiltInClaudeModelsForVersion(testCase.version);
          for (const slug of gatedSlugs) {
            assert.strictEqual(
              models.some((model) => model.slug === slug),
              testCase.slugs.includes(slug),
              `${testCase.version}: ${slug}`,
            );
          }
          if (testCase.upgrade) {
            assert.strictEqual(formatClaudeModelUpgradeMessage(testCase.version), testCase.upgrade);
          }
        }

        const opus47 = getBuiltInClaudeModelsForVersion("2.1.111").find(
          (model) => model.slug === "claude-opus-4-7",
        );
        const opus47Effort = opus47?.capabilities?.optionDescriptors?.find(
          (descriptor) => descriptor.type === "select" && descriptor.id === "effort",
        );
        assert.deepStrictEqual(
          opus47Effort?.type === "select"
            ? opus47Effort.options.find((option) => option.isDefault)
            : undefined,
          { id: "xhigh", label: "Extra High", isDefault: true },
        );

        const fable5 = getBuiltInClaudeModelsForVersion("2.1.170").find(
          (model) => model.slug === "claude-fable-5",
        );
        const fableContext = fable5?.capabilities?.optionDescriptors?.find(
          (descriptor) => descriptor.type === "select" && descriptor.id === "contextWindow",
        );
        assert.deepStrictEqual(
          fableContext?.type === "select"
            ? fableContext.options.map((option) => option.id)
            : undefined,
          ["200k", "1m"],
        );

        const fable51 = getBuiltInClaudeModelsForVersion("2.1.257").find(
          (model) => model.slug === "claude-fable-5-1",
        );
        const fable51Descriptors = fable51?.capabilities?.optionDescriptors ?? [];
        const fable51Effort = fable51Descriptors.find(
          (descriptor) => descriptor.type === "select" && descriptor.id === "effort",
        );
        const fable51Context = fable51Descriptors.find(
          (descriptor) => descriptor.type === "select" && descriptor.id === "contextWindow",
        );
        assert.deepStrictEqual(
          fable51Effort?.type === "select"
            ? {
                options: fable51Effort.options.map((option) => option.id),
                default: fable51Effort.options.find((option) => option.isDefault),
                currentValue: fable51Effort.currentValue,
              }
            : undefined,
          {
            options: ["low", "medium", "high", "xhigh", "max"],
            default: { id: "high", label: "High", isDefault: true },
            currentValue: "high",
          },
        );
        assert.deepStrictEqual(
          fable51Context?.type === "select"
            ? {
                options: fable51Context.options,
                currentValue: fable51Context.currentValue,
              }
            : undefined,
          {
            options: [{ id: "1m", label: "1M", isDefault: true }],
            currentValue: "1m",
          },
        );

        const sonnet5 = getBuiltInClaudeModelsForVersion("2.1.197").find(
          (model) => model.slug === "claude-sonnet-5",
        );
        const sonnetEffort = sonnet5?.capabilities?.optionDescriptors?.find(
          (descriptor) => descriptor.type === "select" && descriptor.id === "effort",
        );
        assert.deepStrictEqual(
          sonnetEffort?.type === "select"
            ? sonnetEffort.options.map((option) => option.id)
            : undefined,
          ["low", "medium", "high", "xhigh", "max", "ultrathink"],
        );

        const opus5 = getBuiltInClaudeModelsForVersion("2.1.219").find(
          (model) => model.slug === "claude-opus-5",
        );
        const opus5Descriptors = opus5?.capabilities?.optionDescriptors ?? [];
        const opus5Effort = opus5Descriptors.find(
          (descriptor) => descriptor.type === "select" && descriptor.id === "effort",
        );
        const opus5Context = opus5Descriptors.find(
          (descriptor) => descriptor.type === "select" && descriptor.id === "contextWindow",
        );
        assert.deepStrictEqual(
          opus5Effort?.type === "select"
            ? opus5Effort.options.find((option) => option.isDefault)
            : undefined,
          { id: "high", label: "High", isDefault: true },
        );
        assert.deepStrictEqual(
          opus5Context?.type === "select"
            ? opus5Context.options.map((option) => option.id)
            : undefined,
          ["1m"],
        );
        assert.equal(
          opus5Descriptors.some(
            (descriptor) => descriptor.type === "boolean" && descriptor.id === "fastMode",
          ),
          true,
        );

        const fastModeSlugs = getBuiltInClaudeModelsForVersion("2.1.219")
          .filter((model) =>
            model.capabilities?.optionDescriptors?.some(
              (descriptor) => descriptor.type === "boolean" && descriptor.id === "fastMode",
            ),
          )
          .map((model) => model.slug);
        assert.deepStrictEqual(fastModeSlugs, ["claude-opus-5", "claude-opus-4-8"]);

        const opus55 = getBuiltInClaudeModelsForVersion("2.1.280").find(
          (model) => model.slug === "claude-opus-5-5",
        );
        const opus55Descriptors = opus55?.capabilities?.optionDescriptors ?? [];
        assert.equal(
          opus55Descriptors.some((descriptor) => descriptor.id === "ultracode"),
          false,
        );
        const opus55Effort = opus55Descriptors.find((descriptor) => descriptor.id === "effort");
        assert.deepStrictEqual(
          opus55Effort?.type === "select"
            ? {
                efforts: opus55Effort.options.map((option) => option.id),
                currentValue: opus55Effort.currentValue,
                default: opus55Effort.options.find((option) => option.isDefault)?.id,
              }
            : undefined,
          {
            efforts: ["low", "medium", "high", "xhigh", "max"],
            currentValue: "medium",
            default: "medium",
          },
        );
        assert.includeDeepMembers(
          [...opus55Descriptors],
          [
            { id: "fastMode", label: "Fast Mode", type: "boolean" },
            {
              id: "contextWindow",
              label: "Context Window",
              type: "select",
              options: [{ id: "1m", label: "1M", isDefault: true }],
              currentValue: "1m",
            },
          ],
        );
        const sonnet55 = getBuiltInClaudeModelsForVersion("2.1.284").find(
          (model) => model.slug === "claude-sonnet-5-5",
        );
        const sonnet55Descriptors = sonnet55?.capabilities?.optionDescriptors ?? [];
        assert.equal(
          sonnet55Descriptors.some(
            (descriptor) => descriptor.id === "ultracode" && descriptor.type === "boolean",
          ),
          true,
        );
        const qualifiedUltraModels = getBuiltInClaudeModelsForVersion("2.1.288").filter((model) =>
          model.capabilities?.optionDescriptors?.some(
            (descriptor) => descriptor.id === "ultracode",
          ),
        );
        assert.isAbove(qualifiedUltraModels.length, 0);
        for (const model of qualifiedUltraModels) {
          const effort = model.capabilities?.optionDescriptors?.find(
            (descriptor) => descriptor.id === "effort",
          );
          assert.equal(
            effort?.type === "select" && effort.options.some((option) => option.id === "xhigh"),
            true,
          );
          assert.equal(
            effort?.type === "select" && effort.options.some((option) => option.id === "ultracode"),
            false,
          );
        }
        for (const version of [undefined, "unknown", "2.1.283"]) {
          assert.equal(
            getBuiltInClaudeModelsForVersion(version).some((model) =>
              model.capabilities?.optionDescriptors?.some(
                (descriptor) => descriptor.id === "ultracode",
              ),
            ),
            false,
          );
        }
        const sonnet55Effort = sonnet55Descriptors.find((descriptor) => descriptor.id === "effort");
        assert.deepStrictEqual(
          sonnet55Effort?.type === "select"
            ? {
                efforts: sonnet55Effort.options.map((option) => option.id),
                currentValue: sonnet55Effort.currentValue,
                default: sonnet55Effort.options.find((option) => option.isDefault)?.id,
              }
            : undefined,
          {
            efforts: ["low", "medium", "high", "xhigh", "max"],
            currentValue: "medium",
            default: "medium",
          },
        );
        // Sonnet's 1M window is native: offering a 200K or [1m] variant would
        // promise a request policy the model does not provide. Fast is Opus-only.
        assert.equal(
          sonnet55Descriptors.some(
            (descriptor) => descriptor.id === "contextWindow" || descriptor.id === "fastMode",
          ),
          false,
        );
        assert.equal(
          formatClaudeModelUpgradeMessage("2.1.284"),
          "Claude Code v2.1.284 is too old for Claude Haiku 5.5. Upgrade to v2.1.293 or newer to access it.",
        );
        assert.isUndefined(formatClaudeModelUpgradeMessage("2.1.293"));

        for (const model of getBuiltInClaudeModelsForVersion("2.1.219")) {
          const descriptors = model.capabilities?.optionDescriptors ?? [];
          const outputStyle = descriptors.find(
            (descriptor) => descriptor.type === "select" && descriptor.id === "outputStyle",
          );
          assert.deepStrictEqual(
            outputStyle?.type === "select"
              ? outputStyle.options.map((option) => option.id)
              : undefined,
            ["providerDefault", "concise"],
            `${model.slug}: output style`,
          );
          assert.equal(
            descriptors.some(
              (descriptor) =>
                descriptor.type === "boolean" &&
                descriptor.id === "agentProgressSummaries" &&
                descriptor.currentValue === true,
            ),
            true,
            `${model.slug}: progress summaries`,
          );
        }
      });

      it("formats Claude subscription labels without probing the provider", () => {
        const cases = [
          { subscriptionType: "maxplan", expected: "Claude Max Subscription" },
          {
            subscriptionType: "Claude Max Subscription",
            expected: "Claude Max Subscription",
          },
          { subscriptionType: "Claude Max", expected: "Claude Max Subscription" },
        ];

        for (const testCase of cases) {
          assert.strictEqual(
            formatClaudeSubscriptionAuthLabel(testCase.subscriptionType),
            testCase.expected,
            testCase.subscriptionType,
          );
        }
      });

      it.effect("returns claude auth email from initialization result", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities({ email: "claude@example.com" }),
          );
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.email, "claude@example.com");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout:
                    '{"loggedIn":true,"authMethod":"claude.ai","account":{"email":"claude@example.com"}}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("runs Claude status probes with the configured Claude HOME", () => {
        const recorded = recordingMockSpawnerLayer((args) => {
          const joined = args.join(" ");
          if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
          if (joined === "auth status")
            return {
              stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
              stderr: "",
              code: 0,
            };
          throw new Error(`Unexpected args: ${joined}`);
        });

        return Effect.gen(function* () {
          const path = yield* Path.Path;
          const claudeHome = path.resolve("/tmp/t3code-claude-home");
          const status = yield* checkClaudeProviderStatus(
            {
              ...defaultClaudeSettings,
              homePath: claudeHome,
            },
            claudeCapabilities(),
          );
          assert.strictEqual(status.status, "ready");
          assert.deepStrictEqual(
            recorded.commands.map((command) => command.env?.HOME),
            [claudeHome],
          );
        }).pipe(Effect.provide(recorded.layer));
      });

      it.effect(
        "keeps Claude status probes on inherited output policy rather than the chat cap",
        () => {
          const recorded = recordingMockSpawnerLayer((args) => {
            assert.deepEqual(args, ["--version"]);
            return { stdout: "2.1.288\n", stderr: "", code: 0 };
          });
          const parent = Object.freeze({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32000" });
          return Effect.gen(function* () {
            const path = yield* Path.Path;
            const status = yield* checkClaudeProviderStatus(
              {
                ...defaultClaudeSettings,
                homePath: path.resolve("synthetic-claude-status-home"),
                maxOutputTokens: 128_000,
              },
              claudeCapabilities(),
              parent,
            );
            assert.equal(status.status, "ready");
            assert.deepEqual(
              recorded.commands.map((command) => command.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS),
              ["32000"],
            );
            assert.equal(parent.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "32000");
          }).pipe(Effect.provide(recorded.layer));
        },
      );

      it.effect("includes probed claude slash commands in the provider snapshot", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities({
              subscriptionType: "maxplan",
              slashCommands: [
                {
                  name: "review",
                  description: "Review a pull request",
                  input: { hint: "pr-or-branch" },
                },
              ],
            }),
          );

          assert.deepStrictEqual(status.slashCommands, [
            {
              name: "review",
              description: "Review a pull request",
              input: { hint: "pr-or-branch" },
            },
          ]);
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("deduplicates probed claude slash commands by name", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities({
              subscriptionType: "maxplan",
              slashCommands: [
                {
                  name: "ui",
                  description: "Explore and refine UI",
                },
                {
                  name: "ui",
                  input: { hint: "component-or-screen" },
                },
              ],
            }),
          );

          assert.deepStrictEqual(status.slashCommands, [
            {
              name: "ui",
              description: "Explore and refine UI",
              input: { hint: "component-or-screen" },
            },
          ]);
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns an api key label for claude api key auth", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities({ tokenSource: "ANTHROPIC_AUTH_TOKEN" }),
          );
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "apiKey");
          assert.strictEqual(status.auth.label, "Claude API Key");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"api-key"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns unavailable when claude is missing", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities(),
          );
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.installed, false);
          assert.strictEqual(status.auth.status, "unknown");
          assert.strictEqual(
            status.message,
            "Claude Agent CLI (`claude`) is not installed or not on PATH.",
          );
        }).pipe(Effect.provide(failingSpawnerLayer("spawn claude ENOENT"))),
      );

      it.effect("returns error when version check fails with non-zero exit code", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities(),
          );
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.installed, true);
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version")
                return {
                  stdout: "",
                  stderr: "Something went wrong",
                  code: 1,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns warning when the Claude initialization result is unavailable", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            noClaudeCapabilities,
          );
          assert.strictEqual(status.status, "warning");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.auth.status, "unknown");
          assert.strictEqual(
            status.message,
            "Could not verify Claude authentication status from initialization result.",
          );
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":false}\n',
                  stderr: "",
                  code: 1,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );
    });
  },
);
