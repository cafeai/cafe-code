import { writeFile } from "node:fs/promises";

import { autoUpdater } from "electron-updater";
import * as Electron from "electron";

export const DESKTOP_UPDATE_DETECTION_PROBE_SWITCH = "--cafe-update-detection-probe";
export const DESKTOP_UPDATE_DETECTION_RESULT_ENV = "CAFE_CODE_UPDATE_DETECTION_RESULT";
export const DESKTOP_UPDATE_DETECTION_EXPECT_VERSION_ENV =
  "CAFE_CODE_UPDATE_DETECTION_EXPECT_VERSION";
export const DESKTOP_UPDATE_DETECTION_CHANNEL_ENV = "CAFE_CODE_UPDATE_DETECTION_CHANNEL";
export const DESKTOP_UPDATE_DETECTION_FEED_URL_ENV = "CAFE_CODE_UPDATE_DETECTION_FEED_URL";
export const DESKTOP_UPDATE_DETECTION_OUTPUT_PREFIX = "CAFE_CODE_UPDATE_DETECTION=";

const UPDATE_CHECK_TIMEOUT_MS = 60_000;

export type DesktopUpdateDetectionFailure =
  | "check-failed"
  | "invalid-channel"
  | "not-packaged"
  | "no-update"
  | "result-file"
  | "unexpected-version";

export interface DesktopUpdateDetectionProbeDependencies {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly isPackaged: boolean;
  readonly currentVersion: string;
  readonly expectedVersion: string | null;
  readonly channel: "latest" | "nightly" | null;
  readonly checkForUpdates: () => Promise<{
    readonly updateAvailable: boolean;
    readonly availableVersion: string | null;
  }>;
}

export interface DesktopUpdateDetectionProbeResult {
  readonly ok: boolean;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly isPackaged: boolean;
  readonly channel: "latest" | "nightly" | null;
  readonly currentVersion: string;
  readonly expectedVersion: string | null;
  readonly updateAvailable: boolean;
  readonly availableVersion: string | null;
  readonly failure: DesktopUpdateDetectionFailure | null;
}

export function isDesktopUpdateDetectionProbeEnabled(
  argv: readonly string[] = process.argv,
): boolean {
  return argv.includes(DESKTOP_UPDATE_DETECTION_PROBE_SWITCH);
}

function resolveUpdateChannel(rawChannel: string | undefined): "latest" | "nightly" | null {
  const channel = rawChannel?.trim() || "latest";
  return channel === "latest" || channel === "nightly" ? channel : null;
}

function baseProbeResult(
  dependencies: DesktopUpdateDetectionProbeDependencies,
): Omit<
  DesktopUpdateDetectionProbeResult,
  "ok" | "updateAvailable" | "availableVersion" | "failure"
> {
  return {
    platform: dependencies.platform,
    arch: dependencies.arch,
    isPackaged: dependencies.isPackaged,
    channel: dependencies.channel,
    currentVersion: dependencies.currentVersion,
    expectedVersion: dependencies.expectedVersion,
  };
}

export async function collectDesktopUpdateDetectionProbeResult(
  dependencies: DesktopUpdateDetectionProbeDependencies,
): Promise<DesktopUpdateDetectionProbeResult> {
  const base = baseProbeResult(dependencies);
  if (!dependencies.isPackaged) {
    return {
      ...base,
      ok: false,
      updateAvailable: false,
      availableVersion: null,
      failure: "not-packaged",
    };
  }
  if (!dependencies.channel) {
    return {
      ...base,
      ok: false,
      updateAvailable: false,
      availableVersion: null,
      failure: "invalid-channel",
    };
  }

  let updateAvailable = false;
  let availableVersion: string | null = null;
  try {
    const result = await dependencies.checkForUpdates();
    updateAvailable = result.updateAvailable;
    availableVersion = result.availableVersion;
  } catch {
    return {
      ...base,
      ok: false,
      updateAvailable: false,
      availableVersion: null,
      failure: "check-failed",
    };
  }

  if (!updateAvailable || !availableVersion) {
    return {
      ...base,
      ok: false,
      updateAvailable,
      availableVersion,
      failure: "no-update",
    };
  }
  if (dependencies.expectedVersion && availableVersion !== dependencies.expectedVersion) {
    return {
      ...base,
      ok: false,
      updateAvailable,
      availableVersion,
      failure: "unexpected-version",
    };
  }

  return {
    ...base,
    ok: true,
    updateAvailable,
    availableVersion,
    failure: null,
  };
}

function withTimeout<A>(promise: Promise<A>, timeoutMs: number): Promise<A> {
  return new Promise<A>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("update check timed out")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error("update check failed"));
      },
    );
  });
}

async function makeRealDependencies(): Promise<DesktopUpdateDetectionProbeDependencies> {
  const channel = resolveUpdateChannel(process.env[DESKTOP_UPDATE_DETECTION_CHANNEL_ENV]);
  const expectedVersion = process.env[DESKTOP_UPDATE_DETECTION_EXPECT_VERSION_ENV]?.trim() || null;

  return {
    platform: process.platform,
    arch: process.arch,
    isPackaged: Electron.app.isPackaged,
    currentVersion: Electron.app.getVersion(),
    expectedVersion,
    channel,
    checkForUpdates: async () => {
      await Electron.app.whenReady();
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = false;
      if (channel) {
        autoUpdater.channel = channel;
        autoUpdater.allowPrerelease = channel === "nightly";
        autoUpdater.allowDowngrade = false;
      }
      const feedUrl = process.env[DESKTOP_UPDATE_DETECTION_FEED_URL_ENV]?.trim();
      if (feedUrl) {
        autoUpdater.setFeedURL({ provider: "generic", url: feedUrl });
      }
      const result = await withTimeout(autoUpdater.checkForUpdates(), UPDATE_CHECK_TIMEOUT_MS);
      return {
        updateAvailable: result?.isUpdateAvailable === true,
        availableVersion: result?.updateInfo.version ?? null,
      };
    },
  };
}

export async function runDesktopUpdateDetectionProbeAndExit(): Promise<void> {
  let result: DesktopUpdateDetectionProbeResult;
  try {
    result = await collectDesktopUpdateDetectionProbeResult(await makeRealDependencies());
  } catch {
    result = {
      ok: false,
      platform: process.platform,
      arch: process.arch,
      isPackaged: Electron.app.isPackaged,
      channel: resolveUpdateChannel(process.env[DESKTOP_UPDATE_DETECTION_CHANNEL_ENV]),
      currentVersion: Electron.app.getVersion(),
      expectedVersion: process.env[DESKTOP_UPDATE_DETECTION_EXPECT_VERSION_ENV]?.trim() || null,
      updateAvailable: false,
      availableVersion: null,
      failure: "check-failed",
    };
  }

  const resultPath = process.env[DESKTOP_UPDATE_DETECTION_RESULT_ENV]?.trim();
  if (resultPath) {
    try {
      await writeFile(resultPath, `${JSON.stringify(result)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch {
      result = { ...result, ok: false, failure: "result-file" };
    }
  }

  console.info(`${DESKTOP_UPDATE_DETECTION_OUTPUT_PREFIX}${JSON.stringify(result)}`);
  Electron.app.exit(result.ok ? 0 : 1);
}
