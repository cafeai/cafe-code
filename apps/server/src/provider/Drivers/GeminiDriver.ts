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

function discoverGeminiModels(input: {
  readonly settings: GeminiSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly fs: FileSystem.FileSystem;
}) {
  return Effect.gen(function* () {
    // No project cwd, workspace material or prompt enters a catalogue
    // discovery session. Register scratch cleanup before the exact child.
    const cwd = yield* input.fs.makeTempDirectoryScoped({ prefix: "cafecode-gemini-catalog-" });
    const cli = yield* qualifyGeminiCli(input.settings.binaryPath, cwd, input.environment).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, input.spawner),
    );
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
    return { version: cli.version, models };
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
          runtimeCapabilities: { liveSteer: "unsupported", threadGoals: "unsupported" },
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
        const result = yield* Effect.result(
          discoverGeminiModels({ settings, environment, spawner, fs }),
        );
        if (result._tag === "Success") {
          return snapshotFor(
            checkedAt,
            {
              installed: true,
              version: result.success.version,
              status: result.success.models.length ? "ready" : "warning",
              auth: { status: "authenticated" },
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
