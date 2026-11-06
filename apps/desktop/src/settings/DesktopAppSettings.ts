import {
  DesktopAppIconSourceSchema,
  DesktopAppIconVariantSchema,
  DesktopServerExposureModeSchema,
  DesktopUpdateChannelSchema,
  type DesktopAppIconSource,
  type DesktopAppIconVariant,
  type DesktopServerExposureMode,
  type DesktopUpdateChannel,
} from "@cafecode/contracts";
import { fromLenientJson } from "@cafecode/shared/schemaJson";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { resolveDefaultDesktopUpdateChannel } from "../updates/updateChannels.ts";

export interface DesktopSettings {
  readonly serverExposureMode: DesktopServerExposureMode;
  readonly serverHttpsEnabled: boolean;
  readonly updateChannel: DesktopUpdateChannel;
  readonly updateChannelConfiguredByUser: boolean;
  /** Mac global dictation is deliberately opt-in and remains disabled on fresh installs. */
  readonly globalDictationEnabled: boolean;
  readonly globalDictationShortcut: string;
  /** Which built-in icon "Default" means on this computer (`dekai` is the unlockable one). */
  readonly appIconVariant: DesktopAppIconVariant;
  /** `custom` shows the privately stored custom icon instead of the variant. */
  readonly appIconSource: DesktopAppIconSource;
  /** Which accent/theme rendering of the variant is stored privately, if any. */
  readonly appIconThemedKey: string | null;
}

export interface DesktopSettingsChange {
  readonly settings: DesktopSettings;
  readonly changed: boolean;
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  serverExposureMode: "local-only",
  serverHttpsEnabled: true,
  updateChannel: "latest",
  updateChannelConfiguredByUser: false,
  globalDictationEnabled: false,
  globalDictationShortcut: "CommandOrControl+Shift+,",
  appIconVariant: "standard",
  appIconSource: "default",
  appIconThemedKey: null,
};

const THEMED_APP_ICON_KEY_PATTERN = /^(?:standard|dekai)-[a-z]{1,16}-(?:dark|light)$/u;

/**
 * Keep a bounded accelerator grammar at the persistence boundary. Global
 * shortcuts preempt other applications, so an unmodified or partially modified
 * key must never be accepted from a renderer or a hand-edited settings file.
 * The physical key list intentionally matches the settings key capture UI.
 */
export function normalizeGlobalDictationShortcut(value: string): string | null {
  const match = /^(?:CommandOrControl|CmdOrCtrl|Command|Cmd)\+Shift\+([A-Z0-9,./;\-=])$/i.exec(
    value,
  );
  return match ? `CommandOrControl+Shift+${match[1]?.toUpperCase()}` : null;
}

const DesktopSettingsDocument = Schema.Struct({
  serverExposureMode: Schema.optionalKey(DesktopServerExposureModeSchema),
  serverHttpsEnabled: Schema.optionalKey(Schema.Boolean),
  updateChannel: Schema.optionalKey(DesktopUpdateChannelSchema),
  updateChannelConfiguredByUser: Schema.optionalKey(Schema.Boolean),
  globalDictationEnabled: Schema.optionalKey(Schema.Boolean),
  globalDictationShortcut: Schema.optionalKey(Schema.String),
  appIconVariant: Schema.optionalKey(DesktopAppIconVariantSchema),
  appIconSource: Schema.optionalKey(DesktopAppIconSourceSchema),
  appIconThemedKey: Schema.optionalKey(Schema.String),
});

type DesktopSettingsDocument = typeof DesktopSettingsDocument.Type;
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const DesktopSettingsJson = fromLenientJson(DesktopSettingsDocument);
const decodeDesktopSettingsJson = Schema.decodeEffect(DesktopSettingsJson);
const encodeDesktopSettingsJson = Schema.encodeEffect(DesktopSettingsJson);

const settingsChange = (settings: DesktopSettings, changed: boolean): DesktopSettingsChange => ({
  settings,
  changed,
});

export class DesktopSettingsWriteError extends Data.TaggedError("DesktopSettingsWriteError")<{
  readonly cause: PlatformError.PlatformError | Schema.SchemaError;
}> {
  override get message() {
    return `Failed to write desktop settings: ${this.cause.message}`;
  }
}

export class GlobalDictationShortcutError extends Data.TaggedError(
  "GlobalDictationShortcutError",
)<{}> {
  override get message() {
    return "Use Command–Shift with a letter, number, or supported punctuation key.";
  }
}

export interface DesktopAppSettingsShape {
  readonly load: Effect.Effect<DesktopSettings>;
  readonly get: Effect.Effect<DesktopSettings>;
  readonly setServerExposureMode: (
    mode: DesktopServerExposureMode,
  ) => Effect.Effect<DesktopSettingsChange, DesktopSettingsWriteError>;
  readonly setServerHttpsEnabled: (
    enabled: boolean,
  ) => Effect.Effect<DesktopSettingsChange, DesktopSettingsWriteError>;
  readonly setUpdateChannel: (
    channel: DesktopUpdateChannel,
  ) => Effect.Effect<DesktopSettingsChange, DesktopSettingsWriteError>;
  readonly setGlobalDictationEnabled: (
    enabled: boolean,
  ) => Effect.Effect<DesktopSettingsChange, DesktopSettingsWriteError>;
  readonly setGlobalDictationShortcut: (
    shortcut: string,
  ) => Effect.Effect<
    DesktopSettingsChange,
    DesktopSettingsWriteError | GlobalDictationShortcutError
  >;
  readonly setAppIcon: (input: {
    readonly variant: DesktopAppIconVariant;
    readonly source: DesktopAppIconSource;
    /** Omit to keep the stored key; null clears it. */
    readonly themedKey?: string | null;
  }) => Effect.Effect<DesktopSettingsChange, DesktopSettingsWriteError>;
}

export class DesktopAppSettings extends Context.Service<
  DesktopAppSettings,
  DesktopAppSettingsShape
>()("cafecode/desktop/AppSettings") {}

export function resolveDefaultDesktopSettings(appVersion: string): DesktopSettings {
  return {
    ...DEFAULT_DESKTOP_SETTINGS,
    updateChannel: resolveDefaultDesktopUpdateChannel(appVersion),
  };
}

function normalizeDesktopSettingsDocument(
  parsed: DesktopSettingsDocument,
  appVersion: string,
): DesktopSettings {
  const defaultSettings = resolveDefaultDesktopSettings(appVersion);
  const parsedUpdateChannel = Option.fromNullishOr(parsed.updateChannel);
  const isLegacySettings = parsed.updateChannelConfiguredByUser === undefined;
  const updateChannelConfiguredByUser =
    parsed.updateChannelConfiguredByUser === true ||
    (isLegacySettings && Option.contains(parsedUpdateChannel, "nightly"));

  return {
    serverExposureMode:
      parsed.serverExposureMode === "network-accessible" ? "network-accessible" : "local-only",
    serverHttpsEnabled: parsed.serverHttpsEnabled ?? defaultSettings.serverHttpsEnabled,
    updateChannel: updateChannelConfiguredByUser
      ? Option.getOrElse(parsedUpdateChannel, () => defaultSettings.updateChannel)
      : defaultSettings.updateChannel,
    updateChannelConfiguredByUser,
    globalDictationEnabled: parsed.globalDictationEnabled === true,
    globalDictationShortcut:
      (parsed.globalDictationShortcut &&
        normalizeGlobalDictationShortcut(parsed.globalDictationShortcut)) ||
      defaultSettings.globalDictationShortcut,
    appIconVariant: parsed.appIconVariant === "dekai" ? "dekai" : "standard",
    appIconSource: parsed.appIconSource === "custom" ? "custom" : "default",
    appIconThemedKey:
      parsed.appIconThemedKey !== undefined &&
      THEMED_APP_ICON_KEY_PATTERN.test(parsed.appIconThemedKey)
        ? parsed.appIconThemedKey
        : null,
  };
}

function toDesktopSettingsDocument(
  settings: DesktopSettings,
  defaults: DesktopSettings,
): DesktopSettingsDocument {
  const document: Mutable<DesktopSettingsDocument> = {};

  if (settings.serverExposureMode !== defaults.serverExposureMode) {
    document.serverExposureMode = settings.serverExposureMode;
  }
  if (settings.serverHttpsEnabled !== defaults.serverHttpsEnabled) {
    document.serverHttpsEnabled = settings.serverHttpsEnabled;
  }
  if (settings.updateChannel !== defaults.updateChannel) {
    document.updateChannel = settings.updateChannel;
  }
  if (settings.updateChannelConfiguredByUser !== defaults.updateChannelConfiguredByUser) {
    document.updateChannelConfiguredByUser = settings.updateChannelConfiguredByUser;
  }
  if (settings.globalDictationEnabled !== defaults.globalDictationEnabled) {
    document.globalDictationEnabled = settings.globalDictationEnabled;
  }
  if (settings.globalDictationShortcut !== defaults.globalDictationShortcut) {
    document.globalDictationShortcut = settings.globalDictationShortcut;
  }
  if (settings.appIconVariant !== defaults.appIconVariant) {
    document.appIconVariant = settings.appIconVariant;
  }
  if (settings.appIconSource !== defaults.appIconSource) {
    document.appIconSource = settings.appIconSource;
  }
  if (settings.appIconThemedKey !== null) {
    document.appIconThemedKey = settings.appIconThemedKey;
  }

  return document;
}

function setServerExposureMode(
  settings: DesktopSettings,
  requestedMode: DesktopServerExposureMode,
): DesktopSettings {
  return settings.serverExposureMode === requestedMode
    ? settings
    : {
        ...settings,
        serverExposureMode: requestedMode,
      };
}

function setServerHttpsEnabled(settings: DesktopSettings, enabled: boolean): DesktopSettings {
  return settings.serverHttpsEnabled === enabled
    ? settings
    : {
        ...settings,
        serverHttpsEnabled: enabled,
      };
}

function setUpdateChannel(
  settings: DesktopSettings,
  requestedChannel: DesktopUpdateChannel,
): DesktopSettings {
  return settings.updateChannel === requestedChannel
    ? settings
    : {
        ...settings,
        updateChannel: requestedChannel,
        updateChannelConfiguredByUser: true,
      };
}

function setGlobalDictationEnabled(settings: DesktopSettings, enabled: boolean): DesktopSettings {
  return settings.globalDictationEnabled === enabled
    ? settings
    : { ...settings, globalDictationEnabled: enabled };
}

function setGlobalDictationShortcut(settings: DesktopSettings, shortcut: string): DesktopSettings {
  return settings.globalDictationShortcut === shortcut
    ? settings
    : { ...settings, globalDictationShortcut: shortcut };
}

function setAppIcon(
  settings: DesktopSettings,
  input: {
    readonly variant: DesktopAppIconVariant;
    readonly source: DesktopAppIconSource;
    readonly themedKey?: string | null;
  },
): DesktopSettings {
  const themedKey =
    input.themedKey === undefined
      ? settings.appIconThemedKey
      : input.themedKey !== null && THEMED_APP_ICON_KEY_PATTERN.test(input.themedKey)
        ? input.themedKey
        : null;
  return settings.appIconVariant === input.variant &&
    settings.appIconSource === input.source &&
    settings.appIconThemedKey === themedKey
    ? settings
    : {
        ...settings,
        appIconVariant: input.variant,
        appIconSource: input.source,
        appIconThemedKey: themedKey,
      };
}

function readSettings(
  fileSystem: FileSystem.FileSystem,
  settingsPath: string,
  appVersion: string,
): Effect.Effect<DesktopSettings> {
  const defaultSettings = resolveDefaultDesktopSettings(appVersion);

  return fileSystem.readFileString(settingsPath).pipe(
    Effect.option,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(defaultSettings),
        onSome: (raw) =>
          decodeDesktopSettingsJson(raw).pipe(
            Effect.map((parsed) => normalizeDesktopSettingsDocument(parsed, appVersion)),
            Effect.catch(() => Effect.succeed(defaultSettings)),
          ),
      }),
    ),
  );
}

const writeSettings = Effect.fn("desktop.settings.writeSettings")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly settingsPath: string;
  readonly settings: DesktopSettings;
  readonly defaultSettings: DesktopSettings;
}): Effect.fn.Return<void, PlatformError.PlatformError | Schema.SchemaError> {
  const directory = input.path.dirname(input.settingsPath);
  const suffix = (yield* Random.nextUUIDv4).replace(/-/g, "");
  const tempPath = `${input.settingsPath}.${process.pid}.${suffix}.tmp`;
  const encoded = yield* encodeDesktopSettingsJson(
    toDesktopSettingsDocument(input.settings, input.defaultSettings),
  );
  yield* input.fileSystem.makeDirectory(directory, { recursive: true });
  yield* input.fileSystem.writeFileString(tempPath, `${encoded}\n`);
  yield* input.fileSystem.rename(tempPath, input.settingsPath);
});

export const layer = Layer.effect(
  DesktopAppSettings,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const settingsRef = yield* SynchronizedRef.make(environment.defaultDesktopSettings);

    const persist = (
      update: (settings: DesktopSettings) => DesktopSettings,
    ): Effect.Effect<DesktopSettingsChange, DesktopSettingsWriteError> =>
      SynchronizedRef.modifyEffect(settingsRef, (settings) => {
        const nextSettings = update(settings);
        if (nextSettings === settings) {
          return Effect.succeed([settingsChange(settings, false), settings] as const);
        }

        return writeSettings({
          fileSystem,
          path,
          settingsPath: environment.desktopSettingsPath,
          settings: nextSettings,
          defaultSettings: environment.defaultDesktopSettings,
        }).pipe(
          Effect.mapError((cause) => new DesktopSettingsWriteError({ cause })),
          Effect.as([settingsChange(nextSettings, true), nextSettings] as const),
        );
      });

    return DesktopAppSettings.of({
      get: SynchronizedRef.get(settingsRef),
      load: Effect.gen(function* () {
        const settings = yield* readSettings(
          fileSystem,
          environment.desktopSettingsPath,
          environment.appVersion,
        );
        return yield* SynchronizedRef.setAndGet(settingsRef, settings);
      }).pipe(Effect.withSpan("desktop.settings.load")),
      setServerExposureMode: (mode) =>
        persist((settings) => setServerExposureMode(settings, mode)).pipe(
          Effect.withSpan("desktop.settings.setServerExposureMode", { attributes: { mode } }),
        ),
      setServerHttpsEnabled: (enabled) =>
        persist((settings) => setServerHttpsEnabled(settings, enabled)).pipe(
          Effect.withSpan("desktop.settings.setServerHttpsEnabled", { attributes: { enabled } }),
        ),
      setUpdateChannel: (channel) =>
        persist((settings) => setUpdateChannel(settings, channel)).pipe(
          Effect.withSpan("desktop.settings.setUpdateChannel", { attributes: { channel } }),
        ),
      setGlobalDictationEnabled: (enabled) =>
        persist((settings) => setGlobalDictationEnabled(settings, enabled)).pipe(
          Effect.withSpan("desktop.settings.setGlobalDictationEnabled", {
            attributes: { enabled },
          }),
        ),
      setGlobalDictationShortcut: (shortcut) => {
        const normalized = normalizeGlobalDictationShortcut(shortcut);
        return normalized === null
          ? Effect.fail(new GlobalDictationShortcutError())
          : persist((settings) => setGlobalDictationShortcut(settings, normalized)).pipe(
              Effect.withSpan("desktop.settings.setGlobalDictationShortcut"),
            );
      },
      setAppIcon: (input) =>
        persist((settings) => setAppIcon(settings, input)).pipe(
          Effect.withSpan("desktop.settings.setAppIcon", {
            attributes: { variant: input.variant, source: input.source },
          }),
        ),
    });
  }),
);

export const layerTest = (initialSettings: DesktopSettings = DEFAULT_DESKTOP_SETTINGS) =>
  Layer.effect(
    DesktopAppSettings,
    Effect.gen(function* () {
      const settingsRef = yield* SynchronizedRef.make(initialSettings);
      const update = (f: (settings: DesktopSettings) => DesktopSettings) =>
        SynchronizedRef.modify(settingsRef, (settings) => {
          const nextSettings = f(settings);
          return [
            {
              settings: nextSettings,
              changed: nextSettings !== settings,
            },
            nextSettings,
          ] as const;
        });

      return DesktopAppSettings.of({
        get: SynchronizedRef.get(settingsRef),
        load: SynchronizedRef.get(settingsRef),
        setServerExposureMode: (mode) =>
          update((settings) => setServerExposureMode(settings, mode)),
        setServerHttpsEnabled: (enabled) =>
          update((settings) => setServerHttpsEnabled(settings, enabled)),
        setUpdateChannel: (channel) => update((settings) => setUpdateChannel(settings, channel)),
        setGlobalDictationEnabled: (enabled) =>
          update((settings) => setGlobalDictationEnabled(settings, enabled)),
        setGlobalDictationShortcut: (shortcut) => {
          const normalized = normalizeGlobalDictationShortcut(shortcut);
          return normalized === null
            ? Effect.fail(new GlobalDictationShortcutError())
            : update((settings) => setGlobalDictationShortcut(settings, normalized));
        },
        setAppIcon: (input) => update((settings) => setAppIcon(settings, input)),
      });
    }),
  );
