/**
 * CodexDriver — first concrete `ProviderDriver` in the new per-instance model.
 *
 * A driver is a plain value (not a Context.Service) whose `create()` returns
 * one `ProviderInstance` bundling:
 *   - `snapshot`   — the live `ServerProviderShape` for this instance;
 *   - `adapter`    — the Codex session/turn/approval runtime;
 *   - `textGeneration` — commit/PR/branch/title generation via `codex exec`.
 *
 * Each call to `create()` captures the `codexConfig` argument in closures
 * owned by the returned instance. Two instances created with different
 * `homePath`s (e.g. `codex_personal` + `codex_work`) therefore run with
 * fully independent Codex app-server processes and `CODEX_HOME`
 * environments — no shared mutable state.
 *
 * Resource lifecycle: `create()` runs in a scope handed in by the registry.
 * Closing that scope releases the adapter's child processes, the managed
 * snapshot's refresh fibre, and the text-generation binaries' transient
 * scratch files. The registry uses this to tear down an instance when its
 * `providerInstances` entry disappears or its config changes.
 *
 * @module provider/Drivers/CodexDriver
 */
import { CodexSettings, ProviderDriverKind, type ServerProvider } from "@cafecode/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeCodexTextGeneration } from "../../textGeneration/CodexTextGeneration.ts";
import { ServerConfig } from "../../config.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeCodexAdapter } from "../Layers/CodexAdapter.ts";
import {
  checkCodexCliProviderStatus,
  makePendingCodexProvider,
  readCodexAccountRateLimits,
} from "../Layers/CodexProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import type { ProviderDriver, ProviderInstance } from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makePackageManagedProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import { resolveProviderRuntimeEnvironment } from "../managedProviderRuntime.ts";
import {
  codexContinuationIdentity,
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
} from "./CodexHomeLayout.ts";
const decodeCodexSettings = Schema.decodeSync(CodexSettings);

const DRIVER_KIND = ProviderDriverKind.make("codex");
// Periodically refresh installation/authentication truth without using the
// heavy app-server metadata path. Full refreshes are single-flight, while
// prompt-triggered usage updates below use only the redacted HTTP request, so
// neither path creates hidden Codex app-server sessions or repeated CLI probe
// queues.
const PERIODIC_SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);
const UPDATE_DEFINITION = {
  provider: DRIVER_KIND,
  npmPackageName: "@openai/codex",
  homebrewFormula: "codex",
  nativeUpdate: null,
} as const;
const UPDATE = makePackageManagedProviderMaintenanceResolver(UPDATE_DEFINITION);
const DEFAULT_SHADOW_HOME_ROOT = "~/.cafe-code/codex-homes";

/**
 * Services the driver needs to materialize an instance. Surfaced as the
 * driver's `R` so the registry layer aggregates these across every
 * registered driver and the runtime satisfies them once.
 */
export type CodexDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig;

/**
 * Stamp instance identity onto a `ServerProvider` snapshot produced by the
 * driver-kind-only codex helpers. Once `buildServerProvider` in
 * `providerSnapshot.ts` is widened to accept `instanceId`/`driver`, this
 * wrapper disappears.
 */
const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
    readonly authActions: ServerProvider["authActions"] | undefined;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    ...(input.authActions ? { authActions: input.authActions } : {}),
    continuation: { groupKey: input.continuationGroupKey },
    runtimeCapabilities: { ...snapshot.runtimeCapabilities, liveSteer: "supported" },
  });

function sanitizeShadowHomeSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+|[._-]+$/g, "");
  return sanitized.length > 0 ? sanitized : "codex";
}

export function withDefaultCodexShadowHome(input: {
  readonly instanceId: ProviderInstance["instanceId"];
  readonly config: CodexSettings;
}): CodexSettings {
  if (input.config.homePath.trim().length > 0 || input.config.shadowHomePath.trim().length > 0) {
    return input.config;
  }

  return {
    ...input.config,
    shadowHomePath: `${DEFAULT_SHADOW_HOME_ROOT}/${sanitizeShadowHomeSegment(String(input.instanceId))}`,
  };
}

export const CodexDriver: ProviderDriver<CodexSettings, CodexDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Codex",
    supportsMultipleInstances: true,
  },
  configSchema: CodexSettings,
  defaultConfig: (): CodexSettings => decodeCodexSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const layoutConfig = withDefaultCodexShadowHome({ instanceId, config });
      const homeLayout = yield* resolveCodexHomeLayout(layoutConfig);
      // A default Cafe-created shadow overlays the user's normal ~/.codex auth
      // so CLI re-login repairs Cafe automatically. An explicit shadow-only
      // instance is different: users configure those paths to hold separate
      // Codex accounts, so its own auth.json is the source of truth.
      const authSource =
        config.homePath.trim().length === 0 && config.shadowHomePath.trim().length > 0
          ? "shadow"
          : "shared";
      const continuationIdentity = codexContinuationIdentity(homeLayout);
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
        authActions:
          layoutConfig.runtimeSource === "bundled" && process.platform === "win32"
            ? { login: true }
            : undefined,
      });
      if (enabled) {
        yield* materializeCodexShadowHome(homeLayout, { authSource }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail: cause.message,
                cause,
              }),
          ),
        );
      }
      yield* Effect.logInfo("codex.home.layout", {
        instanceId,
        mode: homeLayout.mode,
        sharedHomePath: homeLayout.sharedHomePath,
        effectiveHomePath: homeLayout.effectiveHomePath ?? null,
        defaultShadowHomeApplied: layoutConfig !== config,
        authSource,
        sqliteState: homeLayout.mode === "authOverlay" ? "shadow-local" : "direct",
      });
      const runtime = resolveProviderRuntimeEnvironment({
        provider: DRIVER_KIND,
        runtimeSource: layoutConfig.runtimeSource,
        systemBinaryPath: layoutConfig.binaryPath,
        packageMaintenance: UPDATE_DEFINITION,
        baseEnv: processEnv,
      });
      const effectiveConfig = {
        ...layoutConfig,
        enabled,
        binaryPath: runtime.binaryPath,
        homePath: homeLayout.effectiveHomePath ?? "",
      } satisfies CodexSettings;
      const effectiveEnvironment = runtime.env;
      const maintenanceCapabilities =
        effectiveConfig.runtimeSource === "bundled"
          ? runtime.maintenanceCapabilities
          : yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
              binaryPath: effectiveConfig.binaryPath,
              env: effectiveEnvironment,
            });
      const refreshCodexShadowHome = materializeCodexShadowHome(homeLayout, { authSource }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

      // `makeCodexAdapter` and `makeCodexTextGeneration` have `never` error
      // channels at construction time — their failure modes are all on the
      // per-operation closures they return. No `mapError` wrapper is needed
      // here; the registry only has to worry about snapshot-build and
      // spawner-availability failures surfaced from the status probe below.
      const adapter = yield* makeCodexAdapter(effectiveConfig, {
        instanceId,
        environment: effectiveEnvironment,
        prepareRuntimeHome: refreshCodexShadowHome,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      });
      const textGeneration = yield* makeCodexTextGeneration(effectiveConfig, effectiveEnvironment);

      // Build a managed snapshot whose settings never change — mutations come
      // in as instance rebuilds from the registry rather than in-place
      // updates. The snapshot health check intentionally mirrors upstream
      // Codex CLI's cheap `codex --version` + `codex login status` path.
      // Starting `codex app-server` just to draw the provider badge can run
      // model/skill metadata requests and block for long enough to show a
      // false "provider unavailable" warning before the user has sent a
      // message. Real sessions still use the app-server lifecycle below.
      const checkProvider = refreshCodexShadowHome.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("codex.home.authRefreshBeforeStatusFailed", {
            instanceId,
            detail: cause.message,
          }),
        ),
        Effect.andThen(checkCodexCliProviderStatus(effectiveConfig, effectiveEnvironment)),
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      const snapshot = yield* makeManagedServerProvider<CodexSettings>({
        maintenanceCapabilities,
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) =>
          makePendingCodexProvider(settings).pipe(Effect.map(stampIdentity)),
        checkProvider,
        // Prompt sends need fresh rate-limit metadata, not another pair of
        // `codex --version` / `codex login status` subprocesses. Upstream
        // Codex obtains this data from BackendClient's account usage request;
        // use the same bounded, redacted HTTP path against the effective
        // shadow home and leave full health/auth checks on the five-minute and
        // explicit manual-refresh paths.
        refreshAccountUsage: ({ settings, snapshot }) => {
          if (snapshot.auth.status !== "authenticated" || snapshot.auth.type !== "chatgpt") {
            return Effect.succeed(undefined);
          }
          return refreshCodexShadowHome.pipe(
            Effect.catch((cause) =>
              Effect.logWarning("codex.home.authRefreshBeforeUsageFailed", {
                instanceId,
                detail: cause.message,
              }),
            ),
            Effect.andThen(DateTime.now),
            Effect.map(DateTime.formatIso),
            Effect.flatMap((checkedAt) =>
              readCodexAccountRateLimits(settings, effectiveEnvironment, checkedAt),
            ),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          );
        },
        enrichSnapshot: ({ snapshot, publishSnapshot }) =>
          enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
          ),
        refreshInterval: PERIODIC_SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Codex snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
