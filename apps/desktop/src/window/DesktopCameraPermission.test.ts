import { describe, expect, it, vi } from "vitest";

import type * as Electron from "electron";

import {
  allowsTrustedMainFrameCameraCheck,
  allowsTrustedMainFrameCameraRequest,
  installTrustedMainFrameCameraPermission,
  type CameraPermissionSession,
  type CameraPermissionWebContents,
} from "./DesktopCameraPermission.ts";

const TRUSTED_ORIGIN = "http://127.0.0.1:3773";

function makeHarness(session?: CameraPermissionSession) {
  const ownedSession =
    session ??
    ({
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
    } satisfies CameraPermissionSession);
  const frame = {
    origin: TRUSTED_ORIGIN,
    isDestroyed: vi.fn(() => false),
  };
  const webContents = {
    session: ownedSession,
    mainFrame: frame,
    getURL: vi.fn(() => `${TRUSTED_ORIGIN}/thread/local`),
    isDestroyed: vi.fn(() => false),
  } satisfies CameraPermissionWebContents;
  return { frame, session: ownedSession, webContents };
}

function checkDetails(
  patch: Partial<Electron.PermissionCheckHandlerHandlerDetails> = {},
): Electron.PermissionCheckHandlerHandlerDetails {
  return {
    isMainFrame: true,
    mediaType: "video",
    requestingUrl: `${TRUSTED_ORIGIN}/thread/local`,
    securityOrigin: TRUSTED_ORIGIN,
    ...patch,
  };
}

function requestDetails(
  patch: Partial<Electron.MediaAccessPermissionRequest> = {},
): Electron.MediaAccessPermissionRequest {
  return {
    isMainFrame: true,
    requestingUrl: `${TRUSTED_ORIGIN}/thread/local`,
    mediaTypes: ["video"],
    securityOrigin: TRUSTED_ORIGIN,
    ...patch,
  };
}

describe("desktop camera permission", () => {
  it("allows only camera video from the exact live trusted main contents and origin", () => {
    const { frame, webContents } = makeHarness();
    expect(
      allowsTrustedMainFrameCameraCheck(
        webContents,
        "media",
        TRUSTED_ORIGIN,
        checkDetails(),
        webContents,
        TRUSTED_ORIGIN,
      ),
    ).toBe(true);
    expect(
      allowsTrustedMainFrameCameraRequest(
        webContents,
        "media",
        requestDetails(),
        webContents,
        TRUSTED_ORIGIN,
      ),
    ).toBe(true);

    for (const mediaType of ["audio", "unknown"] as const) {
      expect(
        allowsTrustedMainFrameCameraCheck(
          webContents,
          "media",
          TRUSTED_ORIGIN,
          checkDetails({ mediaType }),
          webContents,
          TRUSTED_ORIGIN,
        ),
      ).toBe(false);
    }
    expect(
      allowsTrustedMainFrameCameraCheck(
        webContents,
        "media",
        TRUSTED_ORIGIN,
        { isMainFrame: true, requestingUrl: `${TRUSTED_ORIGIN}/thread/local` },
        webContents,
        TRUSTED_ORIGIN,
      ),
    ).toBe(false);
    for (const mediaTypes of [["audio"], ["video", "audio"], []] as const) {
      expect(
        allowsTrustedMainFrameCameraRequest(
          webContents,
          "media",
          requestDetails({ mediaTypes: [...mediaTypes] }),
          webContents,
          TRUSTED_ORIGIN,
        ),
      ).toBe(false);
    }
    expect(
      allowsTrustedMainFrameCameraRequest(
        webContents,
        "media",
        {
          isMainFrame: true,
          requestingUrl: `${TRUSTED_ORIGIN}/thread/local`,
          securityOrigin: TRUSTED_ORIGIN,
        },
        webContents,
        TRUSTED_ORIGIN,
      ),
    ).toBe(false);
    expect(
      allowsTrustedMainFrameCameraRequest(
        webContents,
        "display-capture",
        requestDetails(),
        webContents,
        TRUSTED_ORIGIN,
      ),
    ).toBe(false);
    expect(
      allowsTrustedMainFrameCameraCheck(
        webContents,
        "geolocation",
        TRUSTED_ORIGIN,
        checkDetails(),
        webContents,
        TRUSTED_ORIGIN,
      ),
    ).toBe(false);
    expect(
      allowsTrustedMainFrameCameraCheck(
        webContents,
        "media",
        "https://attacker.example",
        checkDetails(),
        webContents,
        TRUSTED_ORIGIN,
      ),
    ).toBe(false);
    expect(
      allowsTrustedMainFrameCameraCheck(
        webContents,
        "media",
        TRUSTED_ORIGIN,
        checkDetails({ isMainFrame: false }),
        webContents,
        TRUSTED_ORIGIN,
      ),
    ).toBe(false);
    expect(
      allowsTrustedMainFrameCameraCheck(
        webContents,
        "media",
        TRUSTED_ORIGIN,
        checkDetails({ securityOrigin: "https://attacker.example" }),
        webContents,
        TRUSTED_ORIGIN,
      ),
    ).toBe(false);
    expect(
      allowsTrustedMainFrameCameraCheck(
        webContents,
        "media",
        TRUSTED_ORIGIN,
        checkDetails({ embeddingOrigin: "https://attacker.example" }),
        webContents,
        TRUSTED_ORIGIN,
      ),
    ).toBe(false);
    expect(
      allowsTrustedMainFrameCameraCheck(
        webContents,
        "media",
        TRUSTED_ORIGIN,
        checkDetails({ requestingUrl: "https://attacker.example/camera" }),
        webContents,
        TRUSTED_ORIGIN,
      ),
    ).toBe(false);
    expect(
      allowsTrustedMainFrameCameraCheck(
        {},
        "media",
        TRUSTED_ORIGIN,
        checkDetails(),
        webContents,
        TRUSTED_ORIGIN,
      ),
    ).toBe(false);
    expect(
      allowsTrustedMainFrameCameraRequest(
        webContents,
        "media",
        requestDetails({ isMainFrame: false }),
        webContents,
        TRUSTED_ORIGIN,
      ),
    ).toBe(false);
    expect(
      allowsTrustedMainFrameCameraRequest(
        webContents,
        "media",
        requestDetails({ requestingUrl: "https://attacker.example/camera" }),
        webContents,
        TRUSTED_ORIGIN,
      ),
    ).toBe(false);
    expect(
      allowsTrustedMainFrameCameraRequest(
        webContents,
        "media",
        requestDetails({ securityOrigin: "https://attacker.example" }),
        webContents,
        TRUSTED_ORIGIN,
      ),
    ).toBe(false);
    expect(
      allowsTrustedMainFrameCameraRequest(
        {},
        "media",
        requestDetails(),
        webContents,
        TRUSTED_ORIGIN,
      ),
    ).toBe(false);

    frame.isDestroyed.mockReturnValue(true);
    expect(
      allowsTrustedMainFrameCameraRequest(
        webContents,
        "media",
        requestDetails(),
        webContents,
        TRUSTED_ORIGIN,
      ),
    ).toBe(false);
    frame.isDestroyed.mockReturnValue(false);
    webContents.isDestroyed.mockReturnValue(true);
    expect(
      allowsTrustedMainFrameCameraRequest(
        webContents,
        "media",
        requestDetails(),
        webContents,
        TRUSTED_ORIGIN,
      ),
    ).toBe(false);
    webContents.isDestroyed.mockReturnValue(false);
    frame.origin = "https://attacker.example";
    expect(
      allowsTrustedMainFrameCameraRequest(
        webContents,
        "media",
        requestDetails(),
        webContents,
        TRUSTED_ORIGIN,
      ),
    ).toBe(false);
    frame.origin = TRUSTED_ORIGIN;
    webContents.getURL.mockReturnValue("https://attacker.example/thread/local");
    expect(
      allowsTrustedMainFrameCameraRequest(
        webContents,
        "media",
        requestDetails(),
        webContents,
        TRUSTED_ORIGIN,
      ),
    ).toBe(false);
  });

  it("installs both Electron handlers, fails closed, and removes only its own registration", () => {
    const sharedSession = {
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
    } satisfies CameraPermissionSession;
    const first = makeHarness(sharedSession);
    const removeFirst = installTrustedMainFrameCameraPermission(first.webContents, TRUSTED_ORIGIN);
    const checkHandler = sharedSession.setPermissionCheckHandler.mock.calls[0]![0]!;
    const requestHandler = sharedSession.setPermissionRequestHandler.mock.calls[0]![0]!;

    expect(
      checkHandler(
        first.webContents as unknown as Electron.WebContents,
        "media",
        TRUSTED_ORIGIN,
        checkDetails(),
      ),
    ).toBe(true);
    const callback = vi.fn();
    requestHandler(
      first.webContents as unknown as Electron.WebContents,
      "media",
      callback,
      requestDetails(),
    );
    expect(callback).toHaveBeenCalledWith(true);
    requestHandler(
      first.webContents as unknown as Electron.WebContents,
      "media",
      callback,
      requestDetails({ mediaTypes: ["audio"] }),
    );
    expect(callback).toHaveBeenLastCalledWith(false);

    const second = makeHarness(sharedSession);
    const removeSecond = installTrustedMainFrameCameraPermission(
      second.webContents,
      TRUSTED_ORIGIN,
    );
    removeFirst();
    expect(sharedSession.setPermissionCheckHandler).not.toHaveBeenCalledWith(null);
    expect(sharedSession.setPermissionRequestHandler).not.toHaveBeenCalledWith(null);

    removeSecond();
    removeSecond();
    expect(sharedSession.setPermissionCheckHandler).toHaveBeenLastCalledWith(null);
    expect(sharedSession.setPermissionRequestHandler).toHaveBeenLastCalledWith(null);
    expect(sharedSession.setPermissionCheckHandler).toHaveBeenCalledTimes(3);
    expect(sharedSession.setPermissionRequestHandler).toHaveBeenCalledTimes(3);
  });

  it("rolls back both handlers when Electron rejects a partial installation", () => {
    const setPermissionCheckHandler = vi.fn();
    const installationError = new Error("request handler rejected");
    const setPermissionRequestHandler = vi.fn((handler) => {
      if (handler !== null) throw installationError;
    });
    const { webContents } = makeHarness({
      setPermissionCheckHandler,
      setPermissionRequestHandler,
    });

    expect(() => installTrustedMainFrameCameraPermission(webContents, TRUSTED_ORIGIN)).toThrow(
      installationError,
    );
    expect(setPermissionCheckHandler).toHaveBeenLastCalledWith(null);
    expect(setPermissionRequestHandler).toHaveBeenLastCalledWith(null);
  });

  it("attempts both owned resets without disrupting the remaining window cleanup", () => {
    const resetError = new Error("check reset rejected");
    const setPermissionCheckHandler = vi.fn((handler) => {
      if (handler === null) throw resetError;
    });
    const setPermissionRequestHandler = vi.fn();
    const { webContents } = makeHarness({
      setPermissionCheckHandler,
      setPermissionRequestHandler,
    });
    const remove = installTrustedMainFrameCameraPermission(webContents, TRUSTED_ORIGIN);

    expect(remove).not.toThrow();
    expect(setPermissionCheckHandler).toHaveBeenLastCalledWith(null);
    expect(setPermissionRequestHandler).toHaveBeenLastCalledWith(null);

    remove();
    expect(setPermissionCheckHandler).toHaveBeenCalledTimes(2);
    expect(setPermissionRequestHandler).toHaveBeenCalledTimes(2);
  });
});
