import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it, assert } from "@effect/vitest";
import * as Context from "effect/Context";
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
import { ChildProcessSpawner } from "effect/unstable/process";
import { deepMerge } from "@cafecode/shared/Struct";
import { createModelCapabilities } from "@cafecode/shared/model";
import { applyServerSettingsPatch } from "@cafecode/shared/serverSettings";

import {
  checkCodexCliProviderStatus,
  checkCodexProviderStatus,
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
  mergeProviderSnapshot,
  mergeProviderSnapshots,
  ProviderRegistryLive,
  selectProvidersByKind,
} from "./ProviderRegistry.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService, type ServerSettingsShape } from "../../serverSettings.ts";
import { readProviderStatusCache, resolveProviderStatusCachePath } from "../providerStatusCache.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderInstanceRegistryMutator } from "../Services/ProviderInstanceRegistryMutator.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
const decodeServerSettings = Schema.decodeSync(ServerSettings);
const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const encodeServerSettings = Schema.encodeSync(ServerSettings);
const encodeUnknownJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
// Registry tests provide narrow process-spawner fakes for the provider under
// test. Keep OpenCode disabled in that shared fixture so unrelated tests do not
// try to boot a fake `opencode serve` process and wait for a readiness line the
// fake was never designed to emit.
const encodedDefaultServerSettings = deepMerge(encodeServerSettings(DEFAULT_SERVER_SETTINGS), {
  providers: { opencode: { enabled: false } },
});

const defaultClaudeSettings: ClaudeSettings = Schema.decodeSync(ClaudeSettings)({});
const defaultCodexSettings: CodexSettings = decodeCodexSettings({});
const disabledCodexSettings: CodexSettings = decodeCodexSettings({
  enabled: false,
});

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
          assert.strictEqual(status.auth.label, "ChatGPT Pro 20x Subscription");
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
          const statusFiber = yield* checkCodexProviderStatus(defaultCodexSettings).pipe(
            Effect.provide(hangingScopedSpawnerLayer(killCalls)),
            Effect.forkChild,
          );

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
          auth: { status: "authenticated", type: "chatgpt", email: "old@example.test" },
          checkedAt: "2026-04-14T00:00:00.000Z",
          version: "2026.04.09-f2b0fcd",
          models: [],
          slashCommands: [],
          skills: [],
          accountRateLimits: {
            rateLimits: { primary: { usedPercent: 88, windowDurationMins: 300 } },
            rateLimitResetCredits: { availableCount: 1 },
            checkedAt: "2026-04-14T00:00:00.000Z",
          },
        } as const satisfies ServerProvider;
        const { accountRateLimits: _omitted, ...withoutRateLimits } = previousProvider;
        const refreshedProvider = {
          ...withoutRateLimits,
          auth: { status: "authenticated", type: "chatgpt", email: "new@example.test" },
          checkedAt: "2026-04-14T00:05:00.000Z",
        } as const satisfies ServerProvider;

        assert.strictEqual(
          mergeProviderSnapshot(previousProvider, refreshedProvider).accountRateLimits,
          undefined,
        );
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
            auth: { status: "authenticated" },
            checkedAt: "2026-04-29T10:00:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
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
          const missingBinary = `t3code_codex_missing_`;
          const serverSettings = yield* makeMutableServerSettingsService(
            decodeServerSettings(
              deepMerge(encodedDefaultServerSettings, {
                providers: {
                  // Disable every built-in probe that would otherwise spawn
                  // on the CI host. `enabled: false` short-circuits each
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
                      homePath: `/tmp/${missingBinary}_home`,
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
          const firstMissing = `t3code_codex_first_`;
          const secondMissing = `t3code_codex_second_`;
          const reprobeModel = "settings-reprobe-marker";
          const serverSettings = yield* makeMutableServerSettingsService(
            decodeServerSettings(
              deepMerge(encodedDefaultServerSettings, {
                providers: {
                  codex: { enabled: true, binaryPath: firstMissing },
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
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-",
              }),
            ),
            Layer.provideMerge(TestHttpClientLive),
            Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
            Layer.provideMerge(OpenCodeRuntimeLive),
            // `it.live` does not inherit layers from the outer `it.layer`
            // wrapper, so provide `NodeServices.layer` inline. This is the
            // same real `ChildProcessSpawner` + `FileSystem` + `Path`
            // services that production uses.
            Layer.provideMerge(NodeServices.layer),
          );
          const runtimeServices = yield* Layer.build(providerRegistryLayer).pipe(
            Scope.provide(scope),
          );
          const runtimeServicesWithMutator = runtimeServices as unknown as Context.Context<
            ProviderRegistry | ProviderInstanceRegistryMutator
          >;

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry;
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
      it.effect("uses the Codex CLI login status path for lightweight provider status", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexCliProviderStatus(defaultCodexSettings).pipe(
            Effect.provide(
              mockSpawnerLayer((args) => {
                const joined = args.join(" ");
                if (joined === "--version") {
                  return { stdout: "codex-cli 0.133.0\n", stderr: "", code: 0 };
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
          assert.strictEqual(status.version, "0.133.0");
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "chatgpt");
          assert.strictEqual(status.auth.label, "ChatGPT Subscription");
          assert.deepStrictEqual(
            status.models.map((model) => model.slug),
            [
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

          const status = yield* checkCodexCliProviderStatus(decodeCodexSettings({ homePath })).pipe(
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
                  rate_limit: {
                    primary_window: {
                      used_percent: 10,
                      limit_window_seconds: 3_600,
                      reset_at: 1_780_000_100,
                    },
                  },
                },
              ],
            });
          }) as typeof fetch;

          const status = yield* checkCodexCliProviderStatus(decodeCodexSettings({ homePath })).pipe(
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
          assert.strictEqual(status.accountRateLimits?.rateLimits.primary?.windowDurationMins, 300);
          assert.strictEqual(status.accountRateLimits?.rateLimits.secondary?.usedPercent, 75);
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
          const encodedStatus = encodeUnknownJsonString(status);
          assert.strictEqual(encodedStatus.includes("access-token"), false);
          assert.strictEqual(encodedStatus.includes("refresh-token"), false);
          assert.strictEqual(encodedStatus.includes("account-id"), false);
        }),
      );

      it.effect("ignores Codex auth metadata when the auth file is a symlink", () =>
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
          yield* fileSystem.symlink(targetPath, path.join(homePath, "auth.json"));

          const status = yield* checkCodexCliProviderStatus(decodeCodexSettings({ homePath })).pipe(
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
          const homePath = "/tmp/cafecode-codex-status-home";

          const status = yield* checkCodexCliProviderStatus(decodeCodexSettings({ homePath })).pipe(
            Effect.provide(layer),
          );

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
          const status = yield* checkCodexCliProviderStatus(defaultCodexSettings).pipe(
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
          assert.include(String(status.message), "/login");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "2.1.198\n", stderr: "", code: 0 };
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
              "Claude Code v2.1.110 is too old for Claude Fable 5. Upgrade to v2.1.170 or newer to access it.",
          },
          { version: "2.1.111", slugs: ["claude-opus-4-7"] },
          { version: "2.1.154", slugs: ["claude-opus-4-7", "claude-opus-4-8"] },
          { version: "2.1.170", slugs: ["claude-opus-4-7", "claude-opus-4-8", "claude-fable-5"] },
          {
            version: "2.1.197",
            slugs: ["claude-opus-4-7", "claude-opus-4-8", "claude-fable-5", "claude-sonnet-5"],
          },
        ];
        const gatedSlugs = [
          "claude-opus-4-7",
          "claude-opus-4-8",
          "claude-fable-5",
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
