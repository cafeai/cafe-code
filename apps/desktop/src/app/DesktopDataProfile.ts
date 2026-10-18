import type { DataProfile } from "@cafecode/shared/dataProfile";
import { prepareDebugDataProfile } from "@cafecode/shared/dataProfileStorage";
import * as Context from "effect/Context";

import {
  acceptsDesktopRestartRequest,
  createDesktopRestartRequest,
  DESKTOP_RESTART_EXISTING_FLAG,
} from "./DesktopProfileControl.ts";

export interface DesktopDataProfileStartupShape {
  /** Atomically stop early capture and take its one coalesced control request.
   * Lifecycle calls this only after installing its ordinary native listener. */
  readonly finishEarlyCapture: () => boolean;
}

export class DesktopDataProfileStartup extends Context.Service<
  DesktopDataProfileStartup,
  DesktopDataProfileStartupShape
>()("cafecode/desktop/DataProfileStartup") {}

export interface DesktopDataProfileInput {
  readonly environment: {
    readonly dataProfile: DataProfile;
    readonly configuredBaseDir: string;
    readonly stateDir: string;
    readonly displayName: string;
    readonly path: { readonly join: (...parts: string[]) => string };
  };
  readonly argv: readonly string[];
  readonly prepareDebug?: (configuredRoot: string) => Promise<void>;
  readonly verifySourceBuilds?: () => void;
  readonly native: {
    readonly setName: (name: string) => void;
    readonly setPath: (name: "userData" | "sessionData", value: string) => void;
    readonly requestSingleInstanceLock: (additionalData?: Record<string, unknown>) => boolean;
    readonly onSecondInstance: (receive: (additionalData: unknown) => void) => () => void;
    readonly showFailure: (reason: "profile" | "build") => void;
    readonly quit: () => void;
  };
}

/** Resolve storage and native ownership before constructing settings, secrets,
 * logging or any other foundation layer. The continuation is the only path to
 * those layers: refusal and secondary-instance handoff never initialize them.
 * No received filesystem exception is sent to the UI or used as a fallback. */
export async function initializeDesktopDataProfile<A>(
  input: DesktopDataProfileInput,
  continueStartup: (startup: DesktopDataProfileStartupShape) => A | Promise<A>,
): Promise<A | undefined> {
  const { environment, native } = input;
  try {
    input.verifySourceBuilds?.();
  } catch {
    try {
      native.showFailure("build");
    } finally {
      native.quit();
    }
    return undefined;
  }
  let stopEarlyCapture: (() => void) | undefined;
  let captureFinished = false;
  let pendingRestart = false;
  const finishEarlyCapture = () => {
    if (captureFinished) return false;
    captureFinished = true;
    stopEarlyCapture?.();
    stopEarlyCapture = undefined;
    const pending = pendingRestart;
    pendingRestart = false;
    return pending;
  };

  try {
    if (environment.dataProfile === "debug") {
      await (input.prepareDebug ?? prepareDebugDataProfile)(environment.configuredBaseDir);
      native.setName(environment.displayName);
    }
    native.setPath("userData", environment.stateDir);
    if (environment.dataProfile === "debug") {
      native.setPath(
        "sessionData",
        environment.path.join(environment.stateDir, "chromium-session"),
      );
    }

    // A same-profile restart can arrive while foundation construction is still
    // awaiting IO. Retain only one validated Boolean, never arbitrary argv or
    // received objects, and drain it after the lifecycle listener is installed.
    stopEarlyCapture = native.onSecondInstance((additionalData) => {
      if (!captureFinished && acceptsDesktopRestartRequest(additionalData, environment)) {
        pendingRestart = true;
      }
    });
    const request = input.argv.includes(DESKTOP_RESTART_EXISTING_FLAG)
      ? createDesktopRestartRequest(environment)
      : undefined;
    if (!native.requestSingleInstanceLock(request)) {
      finishEarlyCapture();
      native.quit();
      return undefined;
    }
  } catch {
    finishEarlyCapture();
    try {
      native.showFailure("profile");
    } finally {
      native.quit();
    }
    return undefined;
  }

  // Do not catch continuation failures as namespace failures. Ordinary startup
  // keeps its existing diagnostic handling once this exact profile is admitted.
  try {
    return await continueStartup({ finishEarlyCapture });
  } catch (error) {
    finishEarlyCapture();
    throw error;
  }
}
