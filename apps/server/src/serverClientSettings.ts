/**
 * ServerClientSettings - backend-authoritative client preference service.
 *
 * This owns the full non-secret `ClientSettings` document for every connected
 * renderer. The path deliberately matches the former desktop-local
 * `client-settings.json` location so existing desktop customization becomes
 * the backend-owned value on first server startup.
 */
import {
  ClientSettingsError,
  ClientSettingsSchema,
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettings,
  type ClientSettingsPatch,
} from "@cafecode/contracts";
import { applyClientSettingsPatch } from "@cafecode/shared/clientSettings";
import { fromJsonStringPretty, fromLenientJson } from "@cafecode/shared/schemaJson";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { writeFileStringAtomically } from "./atomicWrite.ts";
import { BrandingImageStore } from "./branding/BrandingImageStore.ts";
import { ServerConfig } from "./config.ts";

const encodeClientSettings = Schema.encodeEffect(ClientSettingsSchema);
const decodeClientSettings = Schema.decodeUnknownEffect(ClientSettingsSchema);
const encodeClientSettingsJson = Schema.encodeUnknownEffect(
  fromJsonStringPretty(ClientSettingsSchema),
);
const ClientSettingsJson = fromLenientJson(ClientSettingsSchema);
const decodeClientSettingsJsonExit = Schema.decodeUnknownExit(ClientSettingsJson);

const normalizeClientSettings = (
  settings: ClientSettings,
): Effect.Effect<ClientSettings, ClientSettingsError> =>
  encodeClientSettings(settings).pipe(
    Effect.flatMap(decodeClientSettings),
    Effect.mapError(
      (cause) =>
        new ClientSettingsError({
          settingsPath: "<memory>",
          detail: `failed to normalize client settings: ${SchemaIssue.makeFormatterDefault()(cause.issue)}`,
          cause,
        }),
    ),
  );

export interface ServerClientSettingsShape {
  /** Start the settings runtime and attach file watching. */
  readonly start: Effect.Effect<void, ClientSettingsError>;

  /** Await settings runtime readiness. */
  readonly ready: Effect.Effect<void, ClientSettingsError>;

  /** Read the current backend-authoritative client settings. */
  readonly getSettings: Effect.Effect<ClientSettings, ClientSettingsError>;

  /** Patch settings and persist. Returns the new full settings object. */
  readonly updateSettings: (
    patch: ClientSettingsPatch,
  ) => Effect.Effect<ClientSettings, ClientSettingsError>;

  /** Stream of settings change events. */
  readonly streamChanges: Stream.Stream<ClientSettings>;
}

export class ServerClientSettingsService extends Context.Service<
  ServerClientSettingsService,
  ServerClientSettingsShape
>()("cafecode/serverClientSettings/ServerClientSettingsService") {
  static readonly layerTest = (overrides: Partial<ClientSettings> = {}) =>
    Layer.effect(
      ServerClientSettingsService,
      Effect.gen(function* () {
        const initialSettings = yield* normalizeClientSettings({
          ...DEFAULT_CLIENT_SETTINGS,
          ...overrides,
        });
        const currentSettingsRef = yield* Ref.make<ClientSettings>(initialSettings);
        const changesPubSub = yield* PubSub.unbounded<ClientSettings>();

        return {
          start: Effect.void,
          ready: Effect.void,
          getSettings: Ref.get(currentSettingsRef),
          updateSettings: (patch) =>
            Ref.get(currentSettingsRef).pipe(
              Effect.map((currentSettings) => applyClientSettingsPatch(currentSettings, patch)),
              Effect.flatMap(normalizeClientSettings),
              Effect.tap((nextSettings) => Ref.set(currentSettingsRef, nextSettings)),
              Effect.tap((nextSettings) =>
                PubSub.publish(changesPubSub, nextSettings).pipe(Effect.asVoid),
              ),
            ),
          streamChanges: Stream.fromPubSub(changesPubSub),
        } satisfies ServerClientSettingsShape;
      }),
    );
}

const makeServerClientSettings = Effect.gen(function* () {
  const { clientSettingsPath } = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const brandingImages = yield* BrandingImageStore;
  const writeSemaphore = yield* Semaphore.make(1);
  const cacheKey = "client-settings" as const;
  const changesPubSub = yield* PubSub.unbounded<ClientSettings>();
  const startedRef = yield* Ref.make(false);
  const startedDeferred = yield* Deferred.make<void, ClientSettingsError>();
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));

  const emitChange = (settings: ClientSettings) =>
    PubSub.publish(changesPubSub, settings).pipe(Effect.asVoid);

  const toSettingsError = (detail: string, cause: unknown) =>
    new ClientSettingsError({
      settingsPath: clientSettingsPath,
      detail,
      cause,
    });

  const readConfigExists = fs
    .exists(clientSettingsPath)
    .pipe(
      Effect.mapError((cause) =>
        toSettingsError("failed to check client settings file existence", cause),
      ),
    );

  const readRawConfig = fs
    .readFileString(clientSettingsPath)
    .pipe(
      Effect.mapError((cause) => toSettingsError("failed to read client settings file", cause)),
    );

  const migrateLegacySidebarBrandImage = (settings: ClientSettings) =>
    Effect.gen(function* () {
      const legacyDataUrl = settings.sidebarBrandImageDataUrl.trim();
      if (legacyDataUrl.length === 0) {
        return settings;
      }

      if (settings.sidebarBrandImage !== null) {
        return {
          ...settings,
          sidebarBrandImageDataUrl: "",
        };
      }

      const migrated = yield* Effect.exit(brandingImages.storeLegacyDataUrl(legacyDataUrl));
      if (migrated._tag === "Failure") {
        yield* Effect.logWarning("failed to migrate legacy sidebar branding image", {
          settingsPath: clientSettingsPath,
          result: "cleared",
        });
        return {
          ...settings,
          sidebarBrandImage: null,
          sidebarBrandImageDataUrl: "",
        };
      }

      return {
        ...settings,
        sidebarBrandImage: migrated.value,
        sidebarBrandImageDataUrl: "",
      };
    });

  const writeSettingsAtomically = Effect.fnUntraced(
    function* (settings: ClientSettings) {
      const settingsJson = yield* encodeClientSettingsJson(settings);

      return yield* writeFileStringAtomically({
        filePath: clientSettingsPath,
        contents: `${settingsJson}\n`,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, pathService),
      );
    },
    Effect.mapError((cause) => toSettingsError("failed to write client settings file", cause)),
  );

  const loadSettingsFromDisk = Effect.gen(function* () {
    if (!(yield* readConfigExists)) {
      return DEFAULT_CLIENT_SETTINGS;
    }

    const raw = yield* readRawConfig;
    const decoded = decodeClientSettingsJsonExit(raw);
    if (decoded._tag === "Failure") {
      yield* Effect.logWarning("failed to parse client-settings.json, using defaults", {
        path: clientSettingsPath,
        issues: Cause.pretty(decoded.cause),
      });
      return DEFAULT_CLIENT_SETTINGS;
    }
    const migrated = yield* migrateLegacySidebarBrandImage(decoded.value);
    if (migrated !== decoded.value) {
      yield* writeSettingsAtomically(migrated);
    }
    return migrated;
  });

  const settingsCache = yield* Cache.make<typeof cacheKey, ClientSettings, ClientSettingsError>({
    capacity: 1,
    lookup: () => loadSettingsFromDisk,
  });

  const getSettingsFromCache = Cache.get(settingsCache, cacheKey);

  const revalidateAndEmit = writeSemaphore.withPermits(1)(
    Effect.gen(function* () {
      yield* Cache.invalidate(settingsCache, cacheKey);
      const settings = yield* getSettingsFromCache;
      yield* emitChange(settings);
    }),
  );

  const startWatcher = Effect.gen(function* () {
    const settingsDir = pathService.dirname(clientSettingsPath);
    const settingsFile = pathService.basename(clientSettingsPath);
    const settingsPathResolved = pathService.resolve(clientSettingsPath);

    yield* fs
      .makeDirectory(settingsDir, { recursive: true })
      .pipe(
        Effect.mapError((cause) =>
          toSettingsError("failed to prepare client settings directory", cause),
        ),
      );

    const revalidateAndEmitSafely = revalidateAndEmit.pipe(Effect.ignoreCause({ log: true }));
    const debouncedSettingsEvents = fs.watch(settingsDir).pipe(
      Stream.filter((event) => {
        return (
          event.path === settingsFile ||
          event.path === clientSettingsPath ||
          pathService.resolve(settingsDir, event.path) === settingsPathResolved
        );
      }),
      Stream.debounce(Duration.millis(100)),
    );

    yield* Stream.runForEach(debouncedSettingsEvents, () => revalidateAndEmitSafely).pipe(
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(watcherScope),
      Effect.asVoid,
    );
  });

  const start = Effect.gen(function* () {
    const shouldStart = yield* Ref.modify(startedRef, (started) => [!started, true]);
    if (!shouldStart) {
      return yield* Deferred.await(startedDeferred);
    }

    const startup = Effect.gen(function* () {
      yield* startWatcher;
      yield* Cache.invalidate(settingsCache, cacheKey);
      yield* getSettingsFromCache;
    });

    const startupExit = yield* Effect.exit(startup);
    if (startupExit._tag === "Failure") {
      yield* Deferred.failCause(startedDeferred, startupExit.cause).pipe(Effect.orDie);
      return yield* Effect.failCause(startupExit.cause);
    }

    yield* Deferred.succeed(startedDeferred, undefined).pipe(Effect.orDie);
  });

  return {
    start,
    ready: Deferred.await(startedDeferred),
    getSettings: getSettingsFromCache,
    updateSettings: (patch) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* getSettingsFromCache;
          const normalized = yield* normalizeClientSettings(
            applyClientSettingsPatch(current, patch),
          );
          const next = yield* migrateLegacySidebarBrandImage(normalized);
          yield* writeSettingsAtomically(next);
          yield* Cache.set(settingsCache, cacheKey, next);
          yield* emitChange(next);
          return next;
        }),
      ),
    streamChanges: Stream.fromPubSub(changesPubSub),
  } satisfies ServerClientSettingsShape;
});

export const ServerClientSettingsLive = Layer.effect(
  ServerClientSettingsService,
  makeServerClientSettings,
);
