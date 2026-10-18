import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  initializeDesktopDataProfile,
  type DesktopDataProfileInput,
} from "./DesktopDataProfile.ts";
import {
  createDesktopRestartRequest,
  DESKTOP_RESTART_EXISTING_FLAG,
} from "./DesktopProfileControl.ts";

function makeFixture(profile: "production" | "debug" = "debug") {
  const order: string[] = [];
  let receive: ((data: unknown) => void) | undefined;
  const environment = {
    dataProfile: profile,
    configuredBaseDir: join("/fixture", "Cafe home"),
    stateDir: join("/fixture", "Cafe home", ...(profile === "debug" ? [".debug"] : []), "userdata"),
    displayName: profile === "debug" ? "Cafe Code (Debug)" : "Cafe Code (Alpha)",
    path: { join },
  };
  const native = {
    setName: vi.fn((name: string) => {
      order.push(`name:${name}`);
    }),
    setPath: vi.fn((name: "userData" | "sessionData", value: string) => {
      order.push(`${name}:${value}`);
    }),
    requestSingleInstanceLock: vi.fn((_request?: Record<string, unknown>) => {
      order.push("lock");
      return true;
    }),
    onSecondInstance: vi.fn((callback: (data: unknown) => void) => {
      order.push("listen");
      receive = callback;
      return () => {
        order.push("unlisten");
        receive = undefined;
      };
    }),
    showFailure: vi.fn(() => {
      order.push("failure");
    }),
    quit: vi.fn(() => {
      order.push("quit");
    }),
  };
  const prepareDebug = vi.fn(async (_root: string) => {
    order.push("prepare");
  });
  const input = { environment, native, prepareDebug, argv: [] } satisfies DesktopDataProfileInput;
  return { input, order, emit: (data: unknown) => receive?.(data) };
}

describe("desktop data profile admission", () => {
  it("holds every foundation operation until Debug storage, session paths and native lock are ready", async () => {
    const fixture = makeFixture();
    let release!: () => void;
    fixture.input.prepareDebug.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const foundation = vi.fn(() => {
      fixture.order.push("foundation");
      return "ready";
    });
    const pending = initializeDesktopDataProfile(fixture.input, foundation);
    expect(fixture.input.prepareDebug).toHaveBeenCalledExactlyOnceWith(
      fixture.input.environment.configuredBaseDir,
    );
    expect(foundation).not.toHaveBeenCalled();
    expect(fixture.order).toEqual([]);
    release();
    expect(await pending).toBe("ready");
    expect(fixture.order).toEqual([
      "name:Cafe Code (Debug)",
      `userData:${fixture.input.environment.stateDir}`,
      `sessionData:${join(fixture.input.environment.stateDir, "chromium-session")}`,
      "listen",
      "lock",
      "foundation",
    ]);
    expect(fixture.input.native.requestSingleInstanceLock).toHaveBeenCalledExactlyOnceWith(
      undefined,
    );
  });

  it("never opens foundation or another profile when Debug storage admission fails", async () => {
    const fixture = makeFixture();
    fixture.input.prepareDebug.mockRejectedValue(
      new Error("private filesystem details and credentials"),
    );
    const foundation = vi.fn();
    expect(await initializeDesktopDataProfile(fixture.input, foundation)).toBeUndefined();
    expect(foundation).not.toHaveBeenCalled();
    expect(fixture.input.native.setPath).not.toHaveBeenCalled();
    expect(fixture.input.native.requestSingleInstanceLock).not.toHaveBeenCalled();
    expect(fixture.input.native.showFailure).toHaveBeenCalledExactlyOnceWith("profile");
    expect(fixture.input.native.quit).toHaveBeenCalledExactlyOnceWith();
    expect(fixture.order).toEqual(["failure", "quit"]);
  });

  it("preserves Production storage and session behavior without touching Debug directories", async () => {
    const fixture = makeFixture("production");
    const foundation = vi.fn(() => "ready");
    expect(await initializeDesktopDataProfile(fixture.input, foundation)).toBe("ready");
    expect(fixture.input.prepareDebug).not.toHaveBeenCalled();
    expect(fixture.input.native.setName).not.toHaveBeenCalled();
    expect(fixture.input.native.setPath).toHaveBeenCalledExactlyOnceWith(
      "userData",
      fixture.input.environment.stateDir,
    );
    expect(foundation).toHaveBeenCalledOnce();
  });

  it("hands a secondary launch to its exact profile without constructing foundation", async () => {
    const fixture = makeFixture();
    fixture.input.native.requestSingleInstanceLock.mockImplementation(() => {
      fixture.order.push("lock");
      return false;
    });
    const foundation = vi.fn();
    await initializeDesktopDataProfile(
      { ...fixture.input, argv: [DESKTOP_RESTART_EXISTING_FLAG] },
      foundation,
    );
    expect(fixture.input.native.requestSingleInstanceLock).toHaveBeenCalledExactlyOnceWith(
      createDesktopRestartRequest(fixture.input.environment),
    );
    expect(fixture.order.slice(-3)).toEqual(["lock", "unlisten", "quit"]);
    expect(foundation).not.toHaveBeenCalled();
    expect(fixture.input.native.showFailure).not.toHaveBeenCalled();
  });

  it("coalesces only accepted native restart requests and retires early capture exactly once", async () => {
    const fixture = makeFixture();
    await initializeDesktopDataProfile(fixture.input, (startup) => {
      fixture.emit(
        createDesktopRestartRequest({ ...fixture.input.environment, dataProfile: "production" }),
      );
      fixture.emit(
        createDesktopRestartRequest({
          ...fixture.input.environment,
          stateDir: join("/other", "userdata"),
        }),
      );
      fixture.emit({ action: "restart" });
      fixture.emit(createDesktopRestartRequest(fixture.input.environment));
      fixture.emit(createDesktopRestartRequest(fixture.input.environment));
      expect(startup.finishEarlyCapture()).toBe(true);
      expect(startup.finishEarlyCapture()).toBe(false);
      fixture.emit(createDesktopRestartRequest(fixture.input.environment));
      expect(startup.finishEarlyCapture()).toBe(false);
      expect(fixture.order.filter((entry) => entry === "unlisten")).toHaveLength(1);
    });
  });

  it("does not queue cross-profile, wrong-root or legacy control messages", async () => {
    const fixture = makeFixture();
    await initializeDesktopDataProfile(fixture.input, (startup) => {
      fixture.emit(
        createDesktopRestartRequest({ ...fixture.input.environment, dataProfile: "production" }),
      );
      fixture.emit(
        createDesktopRestartRequest({
          ...fixture.input.environment,
          stateDir: join("/other", "userdata"),
        }),
      );
      fixture.emit({ action: "restart" });
      fixture.emit(undefined);
      expect(startup.finishEarlyCapture()).toBe(false);
    });
  });

  it("retires early capture and refuses foundation when native lock admission fails", async () => {
    const fixture = makeFixture();
    fixture.input.native.requestSingleInstanceLock.mockImplementation(() => {
      throw new Error("private native error");
    });
    const foundation = vi.fn();
    expect(await initializeDesktopDataProfile(fixture.input, foundation)).toBeUndefined();
    expect(foundation).not.toHaveBeenCalled();
    expect(fixture.input.native.showFailure).toHaveBeenCalledExactlyOnceWith("profile");
    expect(fixture.order.slice(-3)).toEqual(["unlisten", "failure", "quit"]);
    fixture.emit(createDesktopRestartRequest(fixture.input.environment));
  });

  it("does not reinterpret ordinary foundation failure as a profile error", async () => {
    const fixture = makeFixture();
    const failure = new Error("foundation failure");
    await expect(
      initializeDesktopDataProfile(fixture.input, () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(fixture.input.native.showFailure).not.toHaveBeenCalled();
  });

  it("refuses stale source outputs before profile IO, native ownership or foundation construction", async () => {
    const fixture = makeFixture();
    const foundation = vi.fn();
    await initializeDesktopDataProfile(
      {
        ...fixture.input,
        verifySourceBuilds: () => {
          throw new Error("old bundle");
        },
      },
      foundation,
    );
    expect(fixture.input.prepareDebug).not.toHaveBeenCalled();
    expect(fixture.input.native.setPath).not.toHaveBeenCalled();
    expect(fixture.input.native.requestSingleInstanceLock).not.toHaveBeenCalled();
    expect(fixture.input.native.showFailure).toHaveBeenCalledExactlyOnceWith("build");
    expect(fixture.input.native.quit).toHaveBeenCalledExactlyOnceWith();
    expect(foundation).not.toHaveBeenCalled();
  });
});
