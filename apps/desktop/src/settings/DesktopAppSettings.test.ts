import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import {
  DEFAULT_DESKTOP_SETTINGS,
  resolveDefaultDesktopSettings,
  type DesktopSettings as DesktopSettingsValue,
} from "./DesktopAppSettings.ts";
import * as DesktopAppSettings from "./DesktopAppSettings.ts";

const DesktopSettingsPatch = Schema.Struct({
  serverExposureMode: Schema.optionalKey(Schema.Literals(["local-only", "network-accessible"])),
  serverHttpsEnabled: Schema.optionalKey(Schema.Boolean),
  updateChannel: Schema.optionalKey(Schema.Literals(["latest", "nightly"])),
  updateChannelConfiguredByUser: Schema.optionalKey(Schema.Boolean),
  globalDictationEnabled: Schema.optionalKey(Schema.Boolean),
  globalDictationShortcut: Schema.optionalKey(Schema.String),
  appIconVariant: Schema.optionalKey(Schema.Literals(["standard", "dekai"])),
  appIconSource: Schema.optionalKey(Schema.Literals(["default", "custom"])),
  appIconThemedKey: Schema.optionalKey(Schema.String),
});

const decodeDesktopSettingsPatch = Schema.decodeEffect(Schema.fromJsonString(DesktopSettingsPatch));
const encodeDesktopSettingsPatch = Schema.encodeEffect(Schema.fromJsonString(DesktopSettingsPatch));

function makeEnvironmentLayer(baseDir: string, appVersion = "0.0.17") {
  return DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "x64",
    appVersion,
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ CAFE_CODE_HOME: baseDir })),
    ),
  );
}

const withSettings = <A, E, R>(
  effect: Effect.Effect<
    A,
    E,
    R | DesktopAppSettings.DesktopAppSettings | DesktopEnvironment.DesktopEnvironment
  >,
  options?: { readonly appVersion?: string },
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-settings-test-",
    });
    return yield* effect.pipe(
      Effect.provide(
        DesktopAppSettings.layer.pipe(
          Layer.provideMerge(makeEnvironmentLayer(baseDir, options?.appVersion)),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

function writeSettingsPatch(patch: typeof DesktopSettingsPatch.Type) {
  return Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const encoded = yield* encodeDesktopSettingsPatch(patch);
    yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
    yield* fileSystem.writeFileString(environment.desktopSettingsPath, `${encoded}\n`);
  });
}

describe("DesktopSettings", () => {
  it.effect("loads defaults when no settings file exists", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        assert.deepEqual(yield* settings.load, DEFAULT_DESKTOP_SETTINGS);
        assert.deepEqual(yield* settings.get, DEFAULT_DESKTOP_SETTINGS);
      }),
    ),
  );

  it("defaults packaged nightly builds to the nightly update channel", () => {
    assert.deepEqual(resolveDefaultDesktopSettings("0.0.17-nightly.20260415.1"), {
      serverExposureMode: "local-only",
      serverHttpsEnabled: true,
      updateChannel: "nightly",
      updateChannelConfiguredByUser: false,
      globalDictationEnabled: false,
      globalDictationShortcut: "CommandOrControl+Shift+,",
      appIconVariant: "standard",
      appIconSource: "default",
      appIconThemedKey: null,
    } satisfies DesktopSettingsValue);
  });

  it.effect("loads persisted settings and applies semantic updates", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* writeSettingsPatch({
          serverExposureMode: "network-accessible",
          serverHttpsEnabled: false,
          updateChannel: "latest",
          updateChannelConfiguredByUser: true,
          globalDictationEnabled: false,
          globalDictationShortcut: "CommandOrControl+Shift+,",
        });

        assert.deepEqual(yield* settings.load, {
          serverExposureMode: "network-accessible",
          serverHttpsEnabled: false,
          updateChannel: "latest",
          updateChannelConfiguredByUser: true,
          globalDictationEnabled: false,
          globalDictationShortcut: "CommandOrControl+Shift+,",
          appIconVariant: "standard",
          appIconSource: "default",
          appIconThemedKey: null,
        } satisfies DesktopSettingsValue);

        const exposure = yield* settings.setServerExposureMode("local-only");
        assert.isTrue(exposure.changed);
        assert.equal(exposure.settings.serverExposureMode, "local-only");

        const https = yield* settings.setServerHttpsEnabled(true);
        assert.isTrue(https.changed);
        assert.equal(https.settings.serverHttpsEnabled, true);

        const updateChannel = yield* settings.setUpdateChannel("nightly");
        assert.isTrue(updateChannel.changed);
        assert.equal(updateChannel.settings.updateChannel, "nightly");
        assert.equal(updateChannel.settings.updateChannelConfiguredByUser, true);
      }),
    ),
  );

  it.effect("does not persist no-op semantic updates", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;

        const exposure = yield* settings.setServerExposureMode("local-only");
        assert.isFalse(exposure.changed);

        const updateChannel = yield* settings.setUpdateChannel("latest");
        assert.isFalse(updateChannel.changed);
        assert.equal(updateChannel.settings.updateChannelConfiguredByUser, false);

        const https = yield* settings.setServerHttpsEnabled(true);
        assert.isFalse(https.changed);
      }),
    ),
  );

  it.effect("falls back to defaults when the settings file is malformed", () =>
    withSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(environment.desktopSettingsPath, "{not-json");

        assert.deepEqual(yield* settings.load, DEFAULT_DESKTOP_SETTINGS);
      }),
    ),
  );

  it.effect("loads lenient persisted desktop settings JSON", () =>
    withSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(
          environment.desktopSettingsPath,
          `{
            // JSONC-style comments and trailing commas match server settings parsing.
            "serverExposureMode": "network-accessible",
          }\n`,
        );

        assert.deepEqual(yield* settings.load, {
          serverExposureMode: "network-accessible",
          serverHttpsEnabled: true,
          updateChannel: "latest",
          updateChannelConfiguredByUser: false,
          globalDictationEnabled: false,
          globalDictationShortcut: "CommandOrControl+Shift+,",
          appIconVariant: "standard",
          appIconSource: "default",
          appIconThemedKey: null,
        } satisfies DesktopSettingsValue);
      }),
    ),
  );

  it.effect("persists sparse desktop settings documents", () =>
    withSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;

        yield* settings.setServerExposureMode("network-accessible");

        const persisted = yield* decodeDesktopSettingsPatch(
          yield* fileSystem.readFileString(environment.desktopSettingsPath),
        );
        assert.deepEqual(persisted, {
          serverExposureMode: "network-accessible",
        } satisfies typeof DesktopSettingsPatch.Type);
      }),
    ),
  );

  it.effect("persists disabled HTTPS in sparse desktop settings documents", () =>
    withSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;

        yield* settings.setServerHttpsEnabled(false);

        const persisted = yield* decodeDesktopSettingsPatch(
          yield* fileSystem.readFileString(environment.desktopSettingsPath),
        );
        assert.deepEqual(persisted, {
          serverHttpsEnabled: false,
        } satisfies typeof DesktopSettingsPatch.Type);
      }),
    ),
  );

  it.effect("migrates legacy implicit update channels to the runtime default", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* writeSettingsPatch({
          serverExposureMode: "local-only",
          updateChannel: "latest",
        });

        assert.deepEqual(yield* settings.load, {
          serverExposureMode: "local-only",
          serverHttpsEnabled: true,
          updateChannel: "nightly",
          updateChannelConfiguredByUser: false,
          globalDictationEnabled: false,
          globalDictationShortcut: "CommandOrControl+Shift+,",
          appIconVariant: "standard",
          appIconSource: "default",
          appIconThemedKey: null,
        } satisfies DesktopSettingsValue);
      }),
      { appVersion: "0.0.17-nightly.20260415.1" },
    ),
  );

  it.effect("preserves explicit stable update channel on nightly builds", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* writeSettingsPatch({
          serverExposureMode: "local-only",
          updateChannel: "latest",
          updateChannelConfiguredByUser: true,
          globalDictationEnabled: false,
          globalDictationShortcut: "CommandOrControl+Shift+,",
        });

        assert.deepEqual(yield* settings.load, {
          serverExposureMode: "local-only",
          serverHttpsEnabled: true,
          updateChannel: "latest",
          updateChannelConfiguredByUser: true,
          globalDictationEnabled: false,
          globalDictationShortcut: "CommandOrControl+Shift+,",
          appIconVariant: "standard",
          appIconSource: "default",
          appIconThemedKey: null,
        } satisfies DesktopSettingsValue);
      }),
      { appVersion: "0.0.17-nightly.20260415.1" },
    ),
  );

  it.effect("persists opt-in dictation and a validated shortcut", () =>
    withSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;

        assert.isTrue((yield* settings.setGlobalDictationEnabled(true)).changed);
        assert.isTrue((yield* settings.setGlobalDictationShortcut("Command+Shift+D")).changed);
        assert.isFalse((yield* settings.setGlobalDictationShortcut("CmdOrCtrl+Shift+D")).changed);
        assert.deepEqual(
          yield* decodeDesktopSettingsPatch(
            yield* fileSystem.readFileString(environment.desktopSettingsPath),
          ),
          {
            globalDictationEnabled: true,
            globalDictationShortcut: "CommandOrControl+Shift+D",
          },
        );
      }),
    ),
  );

  it.effect("persists the app icon choice sparsely and heals unknown values", () =>
    withSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;

        assert.isTrue((yield* settings.setAppIcon({ variant: "dekai", source: "custom" })).changed);
        assert.isFalse(
          (yield* settings.setAppIcon({ variant: "dekai", source: "custom" })).changed,
        );
        assert.deepEqual(
          yield* decodeDesktopSettingsPatch(
            yield* fileSystem.readFileString(environment.desktopSettingsPath),
          ),
          { appIconVariant: "dekai", appIconSource: "custom" },
        );

        // Restoring both defaults writes nothing for the icon.
        yield* settings.setAppIcon({ variant: "standard", source: "default" });
        assert.deepEqual(
          yield* decodeDesktopSettingsPatch(
            yield* fileSystem.readFileString(environment.desktopSettingsPath),
          ),
          {},
        );

        // A themed key is remembered, and an invalid one never becomes a file name.
        yield* settings.setAppIcon({
          variant: "dekai",
          source: "default",
          themedKey: "dekai-amber-light",
        });
        assert.equal((yield* settings.get).appIconThemedKey, "dekai-amber-light");
        yield* settings.setAppIcon({ variant: "dekai", source: "default", themedKey: "../x" });
        assert.isNull((yield* settings.get).appIconThemedKey);

        yield* fileSystem.writeFileString(
          environment.desktopSettingsPath,
          '{"appIconVariant":"spooky","appIconSource":"/etc/passwd","appIconThemedKey":"../../evil"}',
        );
        const loaded = yield* settings.load;
        assert.equal(loaded.appIconVariant, "standard");
        assert.equal(loaded.appIconSource, "default");
        assert.isNull(loaded.appIconThemedKey);
      }),
    ),
  );

  it.effect("rejects unsafe shortcuts and heals invalid persisted values", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        assert.isTrue(
          yield* settings.setGlobalDictationShortcut("Command+K").pipe(
            Effect.as(false),
            Effect.catch(() => Effect.succeed(true)),
          ),
        );
        assert.isTrue(
          yield* settings.setGlobalDictationShortcut("Shift+D").pipe(
            Effect.as(false),
            Effect.catch(() => Effect.succeed(true)),
          ),
        );

        yield* writeSettingsPatch({
          globalDictationEnabled: true,
          globalDictationShortcut: "Command+K",
        });
        const loaded = yield* settings.load;
        assert.isTrue(loaded.globalDictationEnabled);
        assert.equal(loaded.globalDictationShortcut, "CommandOrControl+Shift+,");
      }),
    ),
  );
});
