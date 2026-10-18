import type {
  DesktopAppBranding,
  DesktopAppStageLabel,
  DesktopRuntimeArch,
  DesktopRuntimeInfo,
} from "@cafecode/contracts";
import { type DataProfile, resolveDataProfileRoot } from "@cafecode/shared/dataProfile";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  type DesktopSettings,
  resolveDefaultDesktopSettings,
} from "../settings/DesktopAppSettings.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import { isNightlyDesktopVersion } from "../updates/updateChannels.ts";

export interface MakeDesktopEnvironmentInput {
  readonly dirname: string;
  readonly homeDirectory: string;
  readonly platform: NodeJS.Platform;
  readonly processArch: string;
  readonly appVersion: string;
  readonly appPath: string;
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly runningUnderArm64Translation: boolean;
}

export interface DesktopEnvironmentShape {
  readonly path: Path.Path;
  readonly dirname: string;
  readonly platform: NodeJS.Platform;
  readonly processArch: string;
  readonly isPackaged: boolean;
  readonly isDevelopment: boolean;
  readonly appVersion: string;
  readonly appPath: string;
  readonly resourcesPath: string;
  readonly homeDirectory: string;
  readonly appDataDirectory: string;
  /** Selected from trusted packaged/source metadata, never diagnostic flags. */
  readonly dataProfile: DataProfile;
  /** Public Cafe home before the immutable profile suffix is applied. */
  readonly configuredBaseDir: string;
  /** Effective profile root; child bootstrap must not apply its suffix again. */
  readonly baseDir: string;
  readonly stateDir: string;
  readonly desktopSettingsPath: string;
  readonly clientSettingsPath: string;
  readonly savedEnvironmentRegistryPath: string;
  readonly providerDaemonMarkerPath: string;
  readonly providerDaemonCredentialPath: string;
  readonly providerDaemonIpcDir: string;
  readonly serverSettingsPath: string;
  readonly logDir: string;
  readonly rootDir: string;
  readonly appRoot: string;
  readonly backendEntryPath: string;
  readonly backendCwd: string;
  readonly preloadPath: string;
  readonly appUpdateYmlPath: string;
  readonly devServerUrl: Option.Option<URL>;
  readonly devRemoteServerEntryPath: Option.Option<string>;
  readonly configuredBackendPort: Option.Option<number>;
  readonly commitHashOverride: Option.Option<string>;
  readonly otlpTracesUrl: Option.Option<string>;
  readonly otlpExportIntervalMs: number;
  readonly branding: DesktopAppBranding;
  readonly displayName: string;
  readonly appUserModelId: string;
  readonly linuxDesktopEntryName: string;
  readonly linuxWmClass: string;
  readonly userDataDirName: string;
  readonly legacyUserDataDirName: string;
  readonly defaultDesktopSettings: DesktopSettings;
  readonly runtimeInfo: DesktopRuntimeInfo;
  readonly resolvePickFolderDefaultPath: (rawOptions: unknown) => Option.Option<string>;
  readonly resolveResourcePathCandidates: (fileName: string) => readonly string[];
  readonly developmentDockIconPath: string;
}

export class DesktopEnvironment extends Context.Service<
  DesktopEnvironment,
  DesktopEnvironmentShape
>()("cafecode/desktop/Environment") {}

const APP_BASE_NAME = "Cafe Code";

function resolveDesktopAppStageLabel(input: {
  readonly dataProfile: DataProfile;
  readonly appVersion: string;
}): DesktopAppStageLabel {
  if (input.dataProfile === "debug") {
    return "Dev";
  }

  return isNightlyDesktopVersion(input.appVersion) ? "Nightly" : "Alpha";
}

function resolveDesktopAppBranding(input: {
  readonly dataProfile: DataProfile;
  readonly appVersion: string;
}): DesktopAppBranding {
  const stageLabel = resolveDesktopAppStageLabel(input);
  return {
    baseName: APP_BASE_NAME,
    stageLabel,
    displayName:
      input.dataProfile === "debug"
        ? `${APP_BASE_NAME} (Debug)`
        : `${APP_BASE_NAME} (${stageLabel})`,
  };
}

function normalizeDesktopArch(arch: string): DesktopRuntimeArch {
  if (arch === "arm64") return "arm64";
  if (arch === "x64") return "x64";
  return "other";
}

function resolveDesktopRuntimeInfo(input: {
  readonly platform: NodeJS.Platform;
  readonly processArch: string;
  readonly runningUnderArm64Translation: boolean;
}): DesktopRuntimeInfo {
  const appArch = normalizeDesktopArch(input.processArch);

  if (input.platform !== "darwin") {
    return {
      hostArch: appArch,
      appArch,
      runningUnderArm64Translation: false,
    };
  }

  const hostArch = appArch === "arm64" || input.runningUnderArm64Translation ? "arm64" : appArch;

  return {
    hostArch,
    appArch,
    runningUnderArm64Translation: input.runningUnderArm64Translation,
  };
}

const makeDesktopEnvironment = Effect.fn("desktop.environment.make")(function* (
  input: MakeDesktopEnvironmentInput,
): Effect.fn.Return<DesktopEnvironmentShape, Config.ConfigError, Path.Path> {
  const path = yield* Path.Path;
  const config = yield* DesktopConfig.DesktopConfig;
  const homeDirectory = input.homeDirectory;
  const devServerUrl = config.devServerUrl;
  const isDevelopment = config.desktopDevelopmentMode;
  // Source executables always use fresh Debug data, whether their renderer is
  // built or watched. A packaged release retains Production even if diagnostic
  // logging is enabled or it inherits a source launcher's environment.
  const dataProfile: DataProfile = input.isPackaged ? "production" : "debug";
  const appDataDirectory =
    input.platform === "win32"
      ? Option.getOrElse(config.appDataDirectory, () =>
          path.join(homeDirectory, "AppData", "Roaming"),
        )
      : input.platform === "darwin"
        ? path.join(homeDirectory, "Library", "Application Support")
        : Option.getOrElse(config.xdgConfigHome, () => path.join(homeDirectory, ".config"));
  const configuredRoot = yield* Option.match(config.cafeCodeHome, {
    onSome: (value) => Effect.succeed(value),
    onNone: () => Effect.succeed(path.join(homeDirectory, ".cafe-code")),
  });
  // Children have their own cwd. Freeze this public path choice as an absolute
  // host-native name before either Electron or private bootstrap can use it.
  // This is lexical normalization only; namespace/identity admission happens
  // before foundation IO and never follows an alias into Production.
  const configuredBaseDir = path.resolve(
    configuredRoot === "~"
      ? homeDirectory
      : configuredRoot.startsWith("~/") || configuredRoot.startsWith("~\\")
        ? path.join(homeDirectory, configuredRoot.slice(2))
        : configuredRoot,
  );
  const baseDir = resolveDataProfileRoot(configuredBaseDir, dataProfile, path);
  const rootDir = path.resolve(input.dirname, "../../..");
  const appRoot = input.isPackaged ? input.appPath : rootDir;
  const branding = resolveDesktopAppBranding({
    dataProfile,
    appVersion: input.appVersion,
  });
  const displayName = branding.displayName;
  // Vite URLs control renderer loading, not persistence. Both source entry
  // paths must resolve the same Debug database and native Electron profile.
  const stateDir = path.join(baseDir, "userdata");
  const userDataDirName = dataProfile === "debug" ? "cafecode-debug" : "cafecode";
  const legacyUserDataDirName = dataProfile === "debug" ? "Cafe Code (Debug)" : "Cafe Code (Alpha)";
  const resourcesPath = input.resourcesPath;

  return DesktopEnvironment.of({
    path,
    dirname: input.dirname,
    platform: input.platform,
    processArch: input.processArch,
    isPackaged: input.isPackaged,
    isDevelopment,
    appVersion: input.appVersion,
    appPath: input.appPath,
    resourcesPath,
    homeDirectory,
    appDataDirectory,
    dataProfile,
    configuredBaseDir,
    baseDir,
    stateDir,
    desktopSettingsPath: path.join(stateDir, "desktop-settings.json"),
    clientSettingsPath: path.join(stateDir, "client-settings.json"),
    savedEnvironmentRegistryPath: path.join(stateDir, "saved-environments.json"),
    providerDaemonMarkerPath: path.join(stateDir, "provider-daemon.json"),
    providerDaemonCredentialPath: path.join(stateDir, "provider-daemon-token.bin"),
    providerDaemonIpcDir: path.join(stateDir, "provider-daemon-ipc"),
    serverSettingsPath: path.join(stateDir, "settings.json"),
    logDir: path.join(stateDir, "logs"),
    rootDir,
    appRoot,
    backendEntryPath: path.join(appRoot, "apps/server/dist/bin.mjs"),
    backendCwd: input.isPackaged ? homeDirectory : appRoot,
    preloadPath: path.join(input.dirname, "preload.cjs"),
    appUpdateYmlPath: input.isPackaged
      ? path.join(resourcesPath, "app-update.yml")
      : path.join(input.appPath, "dev-app-update.yml"),
    devServerUrl,
    devRemoteServerEntryPath: config.devRemoteServerEntryPath,
    configuredBackendPort: config.configuredBackendPort,
    commitHashOverride: config.commitHashOverride,
    otlpTracesUrl: config.otlpTracesUrl,
    otlpExportIntervalMs: config.otlpExportIntervalMs,
    branding,
    displayName,
    appUserModelId: dataProfile === "debug" ? "com.cafeai.cafecode.debug" : "com.cafeai.cafecode",
    linuxDesktopEntryName: dataProfile === "debug" ? "cafecode-debug.desktop" : "cafecode.desktop",
    linuxWmClass: dataProfile === "debug" ? "cafecode-debug" : "cafecode",
    userDataDirName,
    legacyUserDataDirName,
    defaultDesktopSettings: resolveDefaultDesktopSettings(input.appVersion),
    runtimeInfo: resolveDesktopRuntimeInfo({
      platform: input.platform,
      processArch: input.processArch,
      runningUnderArm64Translation: input.runningUnderArm64Translation,
    }),
    resolvePickFolderDefaultPath: (rawOptions) => {
      if (typeof rawOptions !== "object" || rawOptions === null) {
        return Option.none();
      }

      const { initialPath } = rawOptions as { initialPath?: unknown };
      if (typeof initialPath !== "string") {
        return Option.none();
      }

      const trimmedPath = initialPath.trim();
      if (trimmedPath.length === 0) {
        return Option.none();
      }

      if (trimmedPath === "~") {
        return Option.some(homeDirectory);
      }

      if (trimmedPath.startsWith("~/") || trimmedPath.startsWith("~\\")) {
        return Option.some(path.join(homeDirectory, trimmedPath.slice(2)));
      }

      return Option.some(path.resolve(trimmedPath));
    },
    resolveResourcePathCandidates: (fileName) => [
      path.join(input.dirname, "../resources", fileName),
      path.join(input.dirname, "../prod-resources", fileName),
      path.join(resourcesPath, "resources", fileName),
      path.join(resourcesPath, fileName),
    ],
    developmentDockIconPath: path.join(
      rootDir,
      "assets",
      "app-icon",
      "cafe-code-app-icon-macos-1024.png",
    ),
  });
});

export const layer = (input: MakeDesktopEnvironmentInput) =>
  Layer.effect(DesktopEnvironment, makeDesktopEnvironment(input));
