import { cafeCodeConfigWithDefault, cafeCodeOptionalConfig } from "@cafecode/shared/compatEnv";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Option from "effect/Option";

const trimNonEmptyOption = (value: string): Option.Option<string> => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
};

const trimmedString = (name: string) =>
  (name.startsWith("CAFE_CODE_")
    ? cafeCodeOptionalConfig(name, Config.string)
    : Config.string(name).pipe(Config.option)
  ).pipe(Config.map(Option.flatMap(trimNonEmptyOption)));

const optionalBoolean = (name: string) =>
  cafeCodeOptionalConfig(name, Config.boolean).pipe(Config.map(Option.getOrElse(() => false)));

const commaSeparatedStrings = (name: string) =>
  trimmedString(name).pipe(
    Config.map(
      Option.match({
        onNone: () => [],
        onSome: (value) =>
          value
            .split(",")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0),
      }),
    ),
  );

const compactEnv = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

export const DesktopConfig = Config.all({
  appDataDirectory: trimmedString("APPDATA"),
  xdgConfigHome: trimmedString("XDG_CONFIG_HOME"),
  cafeCodeHome: trimmedString("CAFE_CODE_HOME"),
  desktopDevelopmentMode: optionalBoolean("CAFE_CODE_DESKTOP_DEV"),
  devServerUrl: Config.url("VITE_DEV_SERVER_URL").pipe(Config.option),
  devRemoteServerEntryPath: trimmedString("CAFE_CODE_DEV_REMOTE_SERVER_ENTRY_PATH"),
  configuredBackendPort: cafeCodeOptionalConfig("CAFE_CODE_PORT", Config.port),
  commitHashOverride: trimmedString("CAFE_CODE_COMMIT_HASH"),
  desktopLanHostOverride: trimmedString("CAFE_CODE_DESKTOP_LAN_HOST"),
  desktopHttpsEndpointUrls: commaSeparatedStrings("CAFE_CODE_DESKTOP_HTTPS_ENDPOINTS"),
  otlpTracesUrl: trimmedString("CAFE_CODE_OTLP_TRACES_URL"),
  otlpExportIntervalMs: cafeCodeConfigWithDefault(
    "CAFE_CODE_OTLP_EXPORT_INTERVAL_MS",
    Config.int,
    10_000,
  ),
  appImagePath: trimmedString("APPIMAGE"),
  disableAutoUpdate: optionalBoolean("CAFE_CODE_DISABLE_AUTO_UPDATE"),
  mockUpdates: optionalBoolean("CAFE_CODE_DESKTOP_MOCK_UPDATES"),
  mockUpdateServerPort: cafeCodeConfigWithDefault(
    "CAFE_CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT",
    Config.port,
    3000,
  ),
});

export const layerTest = (env: Readonly<Record<string, string | undefined>>) =>
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: compactEnv(env) }));
