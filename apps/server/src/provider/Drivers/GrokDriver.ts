/**
 * Per-instance Grok Build driver backed by a Cafe-owned ACP stdio process.
 * Grok home participates in continuation identity because its persisted ACP
 * sessions and credentials are home-scoped; a hash keeps that local path out
 * of renderer-visible provider snapshots.
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { GrokSettings, ProviderDriverKind, type ServerProvider } from "@cafecode/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { makeGrokTextGeneration } from "../../textGeneration/GrokTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { readGrokAccountRateLimits } from "../grokAccountUsage.ts";
import { makeGrokAdapter } from "../Layers/GrokAdapter.ts";
import { checkGrokProviderStatus, makePendingGrokProvider } from "../Layers/GrokProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import type { ProviderDriver, ProviderInstance } from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

const DRIVER_KIND = ProviderDriverKind.make("grok");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);
const decodeGrokSettings = Schema.decodeSync(GrokSettings);

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
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnvironment = mergeProviderInstanceEnvironment(environment);
      const effectiveConfig = { ...config, enabled } satisfies GrokSettings;
      const continuationKey = makeGrokContinuationGroupKey(instanceId, effectiveConfig.homePath);
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationKey,
      });
      const maintenanceCapabilities = makeManualOnlyProviderMaintenanceCapabilities({
        provider: DRIVER_KIND,
        packageName: null,
      });
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
              accountRateLimits ? { ...checked, accountRateLimits } : checked,
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
        // Terminal turn events refresh this lightweight usage path without
        // starting a second Grok process. The full five-minute probe still
        // feature-detects `x.ai/billing`; stable 1.0.4 uses this same bounded
        // CLI-proxy fallback until the extension is externally routed.
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

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity: { driverKind: DRIVER_KIND, continuationKey },
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
