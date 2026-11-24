import {
  GeminiSettings,
  ProviderDriverKind,
  TextGenerationError,
  type ServerProvider,
  type ServerProviderAccountRateLimits,
} from "@cafecode/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
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
import {
  geminiVerificationUrl,
  geminiVerificationUrlFromJsonRpcLine,
  makeGeminiLogin,
} from "../geminiLogin.ts";
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

type QualifiedGeminiCli = Effect.Success<ReturnType<typeof qualifyGeminiCli>>;

function qualifyConfiguredGeminiCli(input: GeminiProbeOptions, cwd: string) {
  return qualifyGeminiCli(input.settings.binaryPath, cwd, input.environment).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, input.spawner),
  );
}

function geminiQuotaSource(fs: FileSystem.FileSystem, cli: QualifiedGeminiCli) {
  // This detects observed executable replacement. The stat and printed
  // version identify a source for a historical display, never a login.
  return fs.stat(cli.binaryPath).pipe(
    Effect.map((info) => {
      const inode = Option.getOrUndefined(info.ino);
      const modified = Option.getOrUndefined(info.mtime)?.getTime();
      return info.type === "File" &&
        typeof inode === "number" &&
        Number.isSafeInteger(inode) &&
        inode > 0 &&
        Number.isFinite(modified)
        ? JSON.stringify([
            cli.binaryPath,
            cli.version,
            info.dev,
            inode,
            modified,
            String(info.size),
          ])
        : null;
    }),
    Effect.orElseSucceed(() => null),
  );
}

function discoverGeminiModels(input: GeminiProbeOptions) {
  return Effect.gen(function* () {
    // A catalogue may fail after executable qualification. Retain that
    // observed identity across the native child's joined cleanup, without
    // re-running discovery or inferring the login from its output.
    const observation: { cli?: QualifiedGeminiCli; verificationUrl: string | null } = {
      verificationUrl: null,
    };
    const result = yield* Effect.gen(function* () {
      // No project cwd, workspace material or prompt enters a catalogue
      // discovery session. Register scratch cleanup before the exact child.
      const cwd = yield* input.fs.makeTempDirectoryScoped({ prefix: "cafecode-gemini-catalog-" });
      const cli = yield* qualifyConfiguredGeminiCli(input, cwd);
      observation.cli = cli;
      // Observe bounded JSON-RPC error lines on the catalog probe's stdout so
      // Google account verification URLs can be surfaced privately during login
      // without weakening effect-acp's generic AcpRequestError scrubbing.
      const observingSpawner = ChildProcessSpawner.make((command) =>
        input.spawner.spawn(command).pipe(
          Effect.map((child) => {
            const decoder = new TextDecoder("utf-8");
            let pendingLine = "";
            const observeStdout = (chunk: Uint8Array) =>
              Effect.sync(() => {
                if (observation.verificationUrl) return;
                pendingLine += decoder.decode(chunk, { stream: true });
                const lines = pendingLine.split(/\r?\n/u);
                pendingLine = (lines.pop() ?? "").slice(-32_768);
                for (const line of lines) {
                  const found = geminiVerificationUrlFromJsonRpcLine(line);
                  if (found) {
                    observation.verificationUrl = found;
                    break;
                  }
                }
              });
            return {
              ...child,
              stdout: Stream.tap(child.stdout, observeStdout),
            };
          }),
        ),
      );
      const runtime = yield* makeGeminiAcpRuntime({
        binaryPath: cli.binaryPath,
        environment: input.environment,
        childProcessSpawner: observingSpawner,
        cwd,
        clientInfo: { name: "cafe-code", version: APPLICATION_VERSION },
        classifyStartupStderr: (boundedStderr) => {
          if (!observation.verificationUrl) {
            const found = geminiVerificationUrl(boundedStderr);
            if (found) observation.verificationUrl = found;
          }
          return undefined;
        },
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
    }).pipe(Effect.scoped, Effect.timeout("20 seconds"), Effect.result);
    return {
      result,
      qualifiedCli: observation.cli,
      verificationUrl: observation.verificationUrl,
    };
  });
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
      // Both probe paths run under this exact managed owner's snapshot
      // mutation permit. Keep only one observed report in memory. A rebuilt
      // owner cannot borrow it, even when it reuses the configured id.
      let lastQuota: {
        readonly source: string;
        readonly report: ServerProviderAccountRateLimits;
      } | null = null;
      const historicalQuota = (source: string | null) => {
        if (!lastQuota || lastQuota.source !== source) {
          lastQuota = null;
          return null;
        }
        // The CLI report has no account identifier. On an inconclusive read
        // offer the last observation only as historical for this instance.
        return { ...lastQuota.report, stale: true as const };
      };
      const readQuota = Effect.fn("readGeminiQuotaForOwner")(function* (cli: QualifiedGeminiCli) {
        const source = yield* geminiQuotaSource(fs, cli);
        const report = yield* readGeminiAccountRateLimits({
          binaryPath: cli.binaryPath,
          environment,
          spawner,
          fs,
        });
        const currentSource = yield* geminiQuotaSource(fs, cli);
        if (source !== currentSource || report === null) {
          lastQuota = null;
          return null;
        }
        if (report) {
          lastQuota = source === null ? null : { source, report };
          return report;
        }
        return historicalQuota(source);
      });
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
      let lastVerificationUrl: string | null = null;
      const checkProvider = Effect.gen(function* () {
        lastVerificationUrl = null;
        const checkedAt = DateTime.formatIso(yield* DateTime.now);
        if (!input.enabled) return snapshotFor(checkedAt, pending);
        const { result, qualifiedCli, verificationUrl } = yield* discoverGeminiModels(probeOptions);
        if (result._tag === "Success") {
          const accountRateLimits = yield* readQuota(result.success.cli);
          return snapshotFor(
            checkedAt,
            {
              installed: true,
              version: result.success.cli.version,
              status: result.success.models.length ? "ready" : "warning",
              auth: { status: "authenticated" },
              authActions: { login: true, deviceCodeLogin: true },
              ...(accountRateLimits ? { accountRateLimits } : {}),
              ...(result.success.models.length
                ? {}
                : { message: "Antigravity CLI did not advertise any selectable Gemini models." }),
            },
            result.success.models,
          );
        }
        const error = result.failure;
        lastVerificationUrl = verificationUrl;
        const unauthenticated =
          (error._tag === "AcpRequestError" && error.code === -32000) || verificationUrl !== null;
        const installed =
          error._tag !== "GeminiCliQualificationError" || error.reason !== "missing";
        const historicalSource =
          !unauthenticated && qualifiedCli ? yield* geminiQuotaSource(fs, qualifiedCli) : null;
        const accountRateLimits = historicalQuota(historicalSource);
        return snapshotFor(checkedAt, {
          installed,
          version: null,
          status: unauthenticated ? "warning" : "error",
          auth: { status: unauthenticated ? "unauthenticated" : "unknown" },
          ...(installed ? { authActions: { login: true, deviceCodeLogin: true } } : {}),
          ...(accountRateLimits ? { accountRateLimits } : {}),
          message:
            error._tag === "GeminiCliQualificationError"
              ? error.message
              : verificationUrl !== null
                ? "Google requires additional verification for this account before Gemini can be used. Sign in again to open the verification link, then refresh Gemini."
                : unauthenticated
                  ? "Sign in to Gemini from Settings or run agy acp --login, then refresh Gemini."
                  : "Cafe Code could not discover Gemini models from the configured Antigravity CLI.",
        });
      });
      const refreshAccountUsage = Effect.gen(function* () {
        // Antigravity can be updated or replaced independently of Cafe. Recheck
        // this exact configuration without reopening an ACP catalog session.
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "cafecode-gemini-usage-version-" });
        const cli = yield* qualifyConfiguredGeminiCli(probeOptions, cwd);
        return yield* readQuota(cli);
      }).pipe(
        Effect.scoped,
        Effect.catch(() =>
          Effect.sync(() => {
            lastQuota = null;
            return null;
          }),
        ),
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
        refreshAccountUsage: ({ snapshot }) => {
          if (!settings.enabled || snapshot.auth.status === "unauthenticated") {
            return Effect.succeed(null);
          }
          // A transient catalogue failure can leave an explicit historical
          // reading without a current auth determination. Only a full status
          // read can re-establish the authorization to request native usage.
          return snapshot.auth.status === "authenticated"
            ? refreshAccountUsage
            : Effect.succeed(undefined);
        },
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
      const geminiLogin = yield* makeGeminiLogin({
        qualifyCli: (cwd) => qualifyConfiguredGeminiCli(probeOptions, cwd),
        environment,
        spawner,
        fs,
        hasSessions: adapter.listSessions().pipe(Effect.map((sessions) => sessions.length > 0)),
        refresh: (snapshot.refreshAfterAccountChange ?? snapshot.refresh).pipe(
          Effect.map((refreshed) => ({
            authenticated: refreshed.auth.status === "authenticated",
            verificationUrl: lastVerificationUrl,
          })),
        ),
      });
      return {
        instanceId: input.instanceId,
        driverKind: DRIVER,
        continuationIdentity,
        displayName: input.displayName,
        accentColor: input.accentColor,
        enabled: input.enabled,
        snapshot,
        adapter: { ...adapter, ...geminiLogin },
        textGeneration,
      };
    }),
};
