/**
 * Per-instance Grok Build driver backed by a Cafe-owned ACP stdio process.
 * Grok home participates in continuation identity because its persisted ACP
 * sessions and credentials are home-scoped; a hash keeps that local path out
 * of renderer-visible provider snapshots.
 */
import { createHash } from "node:crypto";
// Native provider path boundary: retain host drive, namespace and separator semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { resolve } from "node:path";

import { GrokSettings, ProviderDriverKind, type ServerProvider } from "@cafecode/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { makeGrokTextGeneration } from "../../textGeneration/GrokTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { readGrokAccountRateLimits } from "../grokAccountUsage.ts";
import { makeGrokLogin } from "../grokLogin.ts";
import { makeGrokAdapter } from "../Layers/GrokAdapter.ts";
import { checkGrokProviderStatus, makePendingGrokProvider } from "../Layers/GrokProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import type { ProviderDriver, ProviderInstance } from "../ProviderDriver.ts";
import {
  parseGenericCliVersion,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  createProviderVersionAdvisory,
  hasPathSeparator,
  makeManualOnlyProviderMaintenanceCapabilities,
  makeProviderMaintenanceCapabilities,
  normalizeCommandPath,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";

const DRIVER_KIND = ProviderDriverKind.make("grok");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);
const UPDATE_CHECK_CACHE_TTL_MS = 60 * 60 * 1_000;
const UPDATE_CHECK_TIMEOUT_MS = 4_000;
const decodeGrokSettings = Schema.decodeSync(GrokSettings);
const GrokUpdateCheckPayload = Schema.Struct({
  latestVersion: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeGrokUpdateCheck = Schema.decodeUnknownOption(
  Schema.fromJsonString(GrokUpdateCheckPayload),
);

const latestGrokVersionCache = new Map<
  string,
  { readonly expiresAt: number; readonly version: string | null }
>();

export function isGrokNativeUpdatePath(binaryPath: string): boolean {
  const trimmed = binaryPath.trim();
  if (!trimmed || trimmed === "grok") return true;
  if (!hasPathSeparator(trimmed)) return false;
  const normalized = normalizeCommandPath(trimmed);
  return (
    normalized.endsWith("/.local/bin/grok") ||
    normalized.endsWith("/.local/bin/grok.exe") ||
    normalized.includes("/.grok/bin/")
  );
}

export function resolveGrokMaintenanceCapabilities(
  binaryPath: string,
): ProviderMaintenanceCapabilities {
  const trimmed = binaryPath.trim();
  if (!isGrokNativeUpdatePath(trimmed)) {
    return makeManualOnlyProviderMaintenanceCapabilities({
      provider: DRIVER_KIND,
      packageName: null,
    });
  }
  return makeProviderMaintenanceCapabilities({
    provider: DRIVER_KIND,
    packageName: null,
    updateExecutable: trimmed || "grok",
    updateArgs: ["update"],
    updateLockKey: "grok-native",
  });
}

export function parseGrokLatestVersionFromUpdateCheck(stdout: string): string | null {
  const decoded = decodeGrokUpdateCheck(stdout.trim());
  if (Option.isNone(decoded)) return null;
  const candidate = decoded.value.latestVersion?.trim();
  return candidate ? parseGenericCliVersion(candidate) : null;
}

const resolveGrokLatestVersion = Effect.fn("resolveGrokLatestVersion")(function* (input: {
  readonly settings: GrokSettings;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const command = input.settings.binaryPath.trim() || "grok";
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  const cached = latestGrokVersionCache.get(command);
  if (cached && cached.expiresAt > now) {
    return cached.version;
  }
  const homePath = input.settings.homePath.trim();
  const result = yield* spawnAndCollect(
    command,
    ChildProcess.make(command, ["--no-auto-update", "update", "--check", "--json"], {
      env: {
        ...input.environment,
        ...(homePath ? { GROK_HOME: homePath } : {}),
      },
      extendEnv: true,
      shell: false,
    }),
    { terminationGrace: "1 second" },
  ).pipe(
    Effect.timeoutOption(UPDATE_CHECK_TIMEOUT_MS),
    Effect.map((maybeResult) =>
      Option.match(maybeResult, {
        onNone: () => null,
        onSome: (collected) =>
          collected.code === 0 ? parseGrokLatestVersionFromUpdateCheck(collected.stdout) : null,
      }),
    ),
    Effect.catch(() => Effect.succeed(null)),
  );
  latestGrokVersionCache.set(command, {
    expiresAt: now + UPDATE_CHECK_CACHE_TTL_MS,
    version: result,
  });
  return result;
});

export type GrokDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig;

export function makeGrokContinuationGroupKey(
  instanceId: ProviderInstance["instanceId"],
  homePath: string,
): string {
  const resolvedHome = resolve(expandHomePath(homePath.trim() || "~/.grok"));
  const homeHash = createHash("sha256").update(resolvedHome).digest("hex").slice(0, 20);
  return `${DRIVER_KIND}:instance:${instanceId}:home:${homeHash}`;
}

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
    ...(snapshot.runtimeCapabilities ? { runtimeCapabilities: snapshot.runtimeCapabilities } : {}),
  });

export const GrokDriver: ProviderDriver<GrokSettings, GrokDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Grok Build",
    supportsMultipleInstances: true,
  },
  configSchema: GrokSettings,
  defaultConfig: (): GrokSettings => decodeGrokSettings({}),
  create: ({
    instanceId,
    displayName,
    accentColor,
    environment,
    processEnvironment: admittedEnvironment,
    enabled,
    config,
  }) =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnvironment =
        admittedEnvironment ?? mergeProviderInstanceEnvironment(environment);
      const effectiveConfig = { ...config, enabled } satisfies GrokSettings;
      const continuationKey = makeGrokContinuationGroupKey(instanceId, effectiveConfig.homePath);
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationKey,
      });
      const maintenanceCapabilities = resolveGrokMaintenanceCapabilities(
        effectiveConfig.binaryPath,
      );
      const lastHealthySnapshot = yield* Ref.make<ServerProvider | undefined>(undefined);

      const adapter = yield* makeGrokAdapter(effectiveConfig, {
        instanceId,
        environment: processEnvironment,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      });
      const textGeneration = yield* makeGrokTextGeneration(effectiveConfig, processEnvironment);
      const checkProvider = checkGrokProviderStatus(
        effectiveConfig,
        serverConfig.cwd,
        processEnvironment,
      ).pipe(
        Effect.map(stampIdentity),
        Effect.flatMap((checked) => {
          if (
            checked.status !== "ready" ||
            checked.auth.status !== "authenticated" ||
            checked.accountRateLimits
          ) {
            return Effect.succeed(checked);
          }
          return readGrokAccountRateLimits(effectiveConfig, processEnvironment, checked.checkedAt, {
            clientVersion: checked.version,
          }).pipe(
            Effect.map((accountRateLimits) =>
              accountRateLimits
                ? {
                    ...checked,
                    accountRateLimits,
                    ...(accountRateLimits.rateLimits.planType && !checked.auth.label
                      ? {
                          auth: {
                            ...checked.auth,
                            label: accountRateLimits.rateLimits.planType,
                          },
                        }
                      : {}),
                  }
                : checked,
            ),
          );
        }),
        Effect.flatMap((checked) =>
          checked.status === "ready"
            ? Ref.set(lastHealthySnapshot, checked).pipe(Effect.as(checked))
            : Ref.get(lastHealthySnapshot).pipe(
                Effect.map((lastHealthy) =>
                  lastHealthy
                    ? {
                        ...checked,
                        models: lastHealthy.models,
                        ...(lastHealthy.runtimeCapabilities
                          ? { runtimeCapabilities: lastHealthy.runtimeCapabilities }
                          : {}),
                        message: checked.message
                          ? `${checked.message} Using the last known Grok model catalog.`
                          : "Using the last known Grok model catalog after a transient probe failure.",
                      }
                    : checked,
                ),
              ),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

      const snapshot = yield* makeManagedServerProvider<GrokSettings>({
        maintenanceCapabilities,
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) =>
          makePendingGrokProvider(settings).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          Effect.gen(function* () {
            if (
              !currentSnapshot.enabled ||
              !currentSnapshot.installed ||
              !currentSnapshot.version
            ) {
              return;
            }
            const latestVersion = yield* resolveGrokLatestVersion({
              settings,
              environment: processEnvironment,
            }).pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
            );
            const checkedAt = DateTime.formatIso(yield* DateTime.now);
            yield* publishSnapshot({
              ...currentSnapshot,
              versionAdvisory: createProviderVersionAdvisory({
                driver: DRIVER_KIND,
                currentVersion: currentSnapshot.version,
                latestVersion,
                checkedAt,
                maintenanceCapabilities,
              }),
            });
          }),
        // Terminal turn events refresh this lightweight usage path without
        // starting a second Grok process. The full five-minute probe still
        // feature-detects `_x.ai/billing`; this bounded CLI-proxy fallback
        // covers builds that do not route the extension.
        refreshAccountUsage: ({ settings, snapshot }) => {
          if (snapshot.auth.status !== "authenticated") {
            return Effect.succeed(undefined);
          }
          return DateTime.now.pipe(
            Effect.map(DateTime.formatIso),
            Effect.flatMap((checkedAt) =>
              readGrokAccountRateLimits(settings, processEnvironment, checkedAt, {
                clientVersion: snapshot.version,
              }),
            ),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          );
        },
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build the Grok provider snapshot.",
              cause,
            }),
        ),
      );
      const grokLogin = yield* makeGrokLogin({
        binaryPath: effectiveConfig.binaryPath,
        homePath: effectiveConfig.homePath,
        environment: processEnvironment,
        spawner: childProcessSpawner,
        hasSessions: adapter.listSessions().pipe(Effect.map((sessions) => sessions.length > 0)),
        refresh: snapshot.refreshAfterAccountChange ?? snapshot.refresh,
      });

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity: { driverKind: DRIVER_KIND, continuationKey },
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter: { ...adapter, ...grokLogin },
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
