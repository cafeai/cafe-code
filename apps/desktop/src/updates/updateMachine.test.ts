import { DesktopUpdateStateSchema } from "@cafecode/contracts";
import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";

import {
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadFailure,
  reduceDesktopUpdateStateOnDownloadProgress,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnInstallFailure,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "./updateMachine.ts";

const runtimeInfo = {
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
} as const;

describe("updateMachine", () => {
  it("keeps legacy runtime identity unknown and admits only explicit finite packaging metadata", () => {
    const decodeState = Schema.decodeUnknownSync(DesktopUpdateStateSchema);
    const isState = Schema.is(DesktopUpdateStateSchema);
    const legacyState = createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest");
    expect(Object.hasOwn(decodeState(legacyState), "runtimeKind")).toBe(false);
    for (const runtimeKind of ["source", "packaged"] as const) {
      const state = decodeState({ ...legacyState, runtimeKind });
      expect(state.runtimeKind).toBe(runtimeKind);
      expect(
        reduceDesktopUpdateStateOnNoUpdate(
          reduceDesktopUpdateStateOnCheckStart(state, "2026-10-20T00:00:00.000Z"),
          "2026-10-20T00:00:00.000Z",
        ).runtimeKind,
      ).toBe(runtimeKind);
    }
    for (const runtimeKind of [null, "", "development", "release", true, 1, {}]) {
      expect(isState({ ...legacyState, runtimeKind })).toBe(false);
    }
  });

  it("records the platform install mode in initial state", () => {
    expect(createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest").installMode).toBe(
      "in-app",
    );
    expect(
      createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest", "manual").installMode,
    ).toBe("manual");
  });

  it("clears transient errors when a check starts", () => {
    const state = reduceDesktopUpdateStateOnCheckStart(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest"),
        enabled: true,
        status: "error",
        message: "network",
        errorContext: "check",
        canRetry: true,
      },
      "2026-03-04T00:00:00.000Z",
    );

    expect(state.status).toBe("checking");
    expect(state.message).toBeNull();
    expect(state.errorContext).toBeNull();
    expect(state.canRetry).toBe(false);
  });

  it("records a check failure without exposing an action", () => {
    const state = reduceDesktopUpdateStateOnCheckFailure(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest"),
        enabled: true,
        status: "checking",
      },
      "network unavailable",
      "2026-03-04T00:00:00.000Z",
    );

    expect(state.status).toBe("error");
    expect(state.errorContext).toBe("check");
    expect(state.canRetry).toBe(true);
  });

  it("preserves available version on download failure for retry", () => {
    const state = reduceDesktopUpdateStateOnDownloadFailure(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest"),
        enabled: true,
        status: "downloading",
        availableVersion: "1.1.0",
        downloadPercent: 43,
      },
      "checksum mismatch",
    );

    expect(state.status).toBe("available");
    expect(state.availableVersion).toBe("1.1.0");
    expect(state.errorContext).toBe("download");
    expect(state.canRetry).toBe(true);
  });

  it("transitions to downloaded and then preserves install retry state", () => {
    const downloaded = reduceDesktopUpdateStateOnDownloadComplete(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest"),
        enabled: true,
        status: "downloading",
        availableVersion: "1.1.0",
      },
      "1.1.0",
    );
    const failedInstall = reduceDesktopUpdateStateOnInstallFailure(
      downloaded,
      "backend shutdown timed out",
    );

    expect(downloaded.status).toBe("downloaded");
    expect(downloaded.downloadedVersion).toBe("1.1.0");
    expect(failedInstall.status).toBe("downloaded");
    expect(failedInstall.errorContext).toBe("install");
    expect(failedInstall.canRetry).toBe(true);
  });

  it("clears stale download state when no update is available", () => {
    const state = reduceDesktopUpdateStateOnNoUpdate(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest"),
        enabled: true,
        status: "error",
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
        message: "old failure",
        errorContext: "download",
        canRetry: true,
      },
      "2026-03-04T00:00:00.000Z",
    );

    expect(state.status).toBe("up-to-date");
    expect(state.availableVersion).toBeNull();
    expect(state.downloadedVersion).toBeNull();
    expect(state.message).toBeNull();
    expect(state.errorContext).toBeNull();
  });

  it("tracks available, download start, and progress cleanly", () => {
    const available = reduceDesktopUpdateStateOnUpdateAvailable(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest"),
        enabled: true,
        status: "checking",
      },
      "1.1.0",
      "2026-03-04T00:00:00.000Z",
    );
    const downloading = reduceDesktopUpdateStateOnDownloadStart(available);
    const progress = reduceDesktopUpdateStateOnDownloadProgress(downloading, 55.5);

    expect(available.status).toBe("available");
    expect(available.channel).toBe("latest");
    expect(downloading.status).toBe("downloading");
    expect(downloading.downloadPercent).toBe(0);
    expect(progress.downloadPercent).toBe(55.5);
    expect(progress.errorContext).toBeNull();
  });
});
