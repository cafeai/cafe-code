import {
  GeminiSettings,
  ProviderDriverKind,
  TextGenerationError,
  type ServerProvider,
} from "@cafecode/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { APPLICATION_VERSION } from "../../applicationVersion.ts";
import { ServerConfig } from "../../config.ts";
import type { TextGenerationShape } from "../../textGeneration/TextGeneration.ts";
import { readGeminiAccountRateLimits } from "../acp/GeminiAcpQuota.ts";
import { buildGeminiAcpModels } from "../acp/GeminiAcpSupport.ts";
import { makeGeminiAcpRuntime, qualifyGeminiCli } from "../acp/GeminiAcpRuntime.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeGeminiAdapter } from "../Layers/GeminiAdapter.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { defaultProviderContinuationIdentity, type ProviderDriver } from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { buildServerProvider, type ProviderProbeResult } from "../providerSnapshot.ts";

const DRIVER = ProviderDriverKind.make("gemini");
const DISPLAY_NAME = "Gemini (Antigravity CLI)";
const decodeSettings = Schema.decodeSync(GeminiSettings);

export type GeminiDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | ServerConfig;

function unsupportedTextGeneration(operation: keyof TextGenerationShape) {
  return () =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail:
          "Gemini supports interactive chats. Select a different provider for automatic text generation.",
      }),
    );
}

const textGeneration = {
  generateCommitMessage: unsupportedTextGeneration("generateCommitMessage"),
  generatePrContent: unsupportedTextGeneration("generatePrContent"),
  generateBranchName: unsupportedTextGeneration("generateBranchName"),
  generateThreadTitle: unsupportedTextGeneration("generateThreadTitle"),
  generateThreadMetadata: unsupportedTextGeneration("generateThreadMetadata"),
} satisfies TextGenerationShape;

interface GeminiProbeOptions {
  readonly settings: GeminiSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly fs: FileSystem.FileSystem;
}

function qualifyConfiguredGeminiCli(input: GeminiProbeOptions, cwd: string) {
  return qualifyGeminiCli(input.settings.binaryPath, cwd, input.environment).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, input.spawner),
  );
}

function discoverGeminiModels(input: GeminiProbeOptions) {
  return Effect.gen(function* () {
    // No project cwd, workspace material or prompt enters a catalogue
    // discovery session. Register scratch cleanup before the exact child.
    const cwd = yield* input.fs.makeTempDirectoryScoped({ prefix: "cafecode-gemini-catalog-" });
    const cli = yield* qualifyConfiguredGeminiCli(input, cwd);
    const runtime = yield* makeGeminiAcpRuntime({
      binaryPath: cli.binaryPath,
      environment: input.environment,
      childProcessSpawner: input.spawner,
      cwd,
      clientInfo: { name: "cafe-code", version: APPLICATION_VERSION },
    });
    const started = yield* runtime.start();
    const capabilities = started.initializeResult.agentCapabilities;
    const models = buildGeminiAcpModels(
      yield* runtime.getConfigOptions,
      capabilities?.promptCapabilities,
    );
    if (capabilities?.sessionCapabilities?.close != null) {
      yield* runtime
        .request("session/close", { sessionId: started.sessionId })
        .pipe(Effect.timeoutOption("1 second"), Effect.ignore);
    }
    return { cli, models };
  }).pipe(Effect.scoped, Effect.timeout("20 seconds"));
}

export const GeminiDriver: ProviderDriver<GeminiSettings, GeminiDriverEnv> = {
  driverKind: DRIVER,
  metadata: { displayName: DISPLAY_NAME },
  configSchema: GeminiSettings,
  defaultConfig: () => decodeSettings({}),
  create: (input) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      const settings = { ...input.config, enabled: input.enabled };
      const environment =
        input.processEnvironment ?? mergeProviderInstanceEnvironment(input.environment);
      const probeOptions = { settings, environment, spawner, fs };
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER,
        instanceId: input.instanceId,
      });
      const snapshotFor = (
        checkedAt: string,
        probe: ProviderProbeResult,
        models: ServerProvider["models"] = [],
      ): ServerProvider => ({
        ...buildServerProvider({
          presentation: { displayName: DISPLAY_NAME, showInteractionModeToggle: false },
          enabled: input.enabled,
          checkedAt,
          models,
          runtimeCapabilities: { liveSteer: "supported", threadGoals: "unsupported" },
          probe,
        }),
        driver: DRIVER,
        instanceId: input.instanceId,
        displayName: input.displayName ?? DISPLAY_NAME,
        ...(input.accentColor ? { accentColor: input.accentColor } : {}),
        continuation: { groupKey: continuationIdentity.continuationKey },
      });
      const pending = {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking the configured Antigravity CLI.",
      } satisfies ProviderProbeResult;
      const checkProvider = Effect.gen(function* () {
        const checkedAt = DateTime.formatIso(yield* DateTime.now);
        if (!input.enabled) return snapshotFor(checkedAt, pending);
        const result = yield* Effect.result(discoverGeminiModels(probeOptions));
        if (result._tag === "Success") {
          const accountRateLimits = yield* readGeminiAccountRateLimits({
            ...result.success.cli,
            environment,
            spawner,
            fs,
          });
          return snapshotFor(
            checkedAt,
            {
              installed: true,
              version: result.success.cli.version,
              status: result.success.models.length ? "ready" : "warning",
              auth: { status: "authenticated" },
              ...(accountRateLimits ? { accountRateLimits } : {}),
              ...(result.success.models.length
                ? {}
                : { message: "Antigravity CLI did not advertise any selectable Gemini models." }),
            },
            result.success.models,
          );
        }
        const error = result.failure;
        const unauthenticated = error._tag === "AcpRequestError" && error.code === -32000;
        return snapshotFor(checkedAt, {
          installed: error._tag !== "GeminiCliQualificationError" || error.reason !== "missing",
          version: null,
          status: unauthenticated ? "warning" : "error",
          auth: { status: unauthenticated ? "unauthenticated" : "unknown" },
          message:
            error._tag === "GeminiCliQualificationError"
              ? error.message
              : unauthenticated
                ? "Sign in with the configured Antigravity CLI on this machine, then refresh Gemini."
                : "Cafe Code could not discover Gemini models from the configured Antigravity CLI.",
        });
      });
      const refreshAccountUsage = Effect.gen(function* () {
        // Antigravity can be updated or replaced independently of Cafe. Recheck
        // this exact configuration without reopening an ACP catalog session.
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "cafecode-gemini-usage-version-" });
        const cli = yield* qualifyConfiguredGeminiCli(probeOptions, cwd);
        return (yield* readGeminiAccountRateLimits({ ...cli, environment, spawner, fs })) ?? null;
      }).pipe(
        Effect.scoped,
        // The configured login is external and may change without a stable
        // account identifier. Unavailable observations withdraw older quota.
        Effect.catch(() => Effect.succeed(null)),
      );
      const adapter = yield* makeGeminiAdapter(settings, {
        instanceId: input.instanceId,
        environment,
      });
      const snapshot = yield* makeManagedServerProvider({
        maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
          provider: DRIVER,
          packageName: null,
        }),
        getSettings: Effect.succeed(settings),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: () =>
          DateTime.now.pipe(Effect.map((now) => snapshotFor(DateTime.formatIso(now), pending))),
        checkProvider,
        refreshAccountUsage: ({ snapshot }) =>
          settings.enabled && snapshot.auth.status === "authenticated"
            ? refreshAccountUsage
            : Effect.succeed(null),
        // Discovery needs an empty session. Use normal registry admission and
        // explicit refreshes instead of creating native sessions on a timer.
        probePolicy: { initialRefresh: "external" },
        refreshInterval: null,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER,
              instanceId: input.instanceId,
              detail: "Failed to initialize the Gemini provider status.",
              cause,
            }),
        ),
      );
      return {
        instanceId: input.instanceId,
        driverKind: DRIVER,
        continuationIdentity,
        displayName: input.displayName,
        accentColor: input.accentColor,
        enabled: input.enabled,
        snapshot,
        adapter,
        textGeneration,
      };
    }),
};
