import { describe, expect, it, vi } from "vitest";

import {
  acceptsDesktopRestartRequest,
  createDesktopRestartRequest,
  DESKTOP_RESTART_EXISTING_FLAG,
  desktopRelaunchArguments,
} from "./DesktopProfileControl.ts";

const debug = { dataProfile: "debug", stateDir: "/synthetic/cafe/.debug/userdata" } as const;
const production = { dataProfile: "production", stateDir: "/synthetic/cafe/userdata" } as const;

describe("DesktopProfileControl", () => {
  it("admits only the exact selected profile/root, including custom roots", () => {
    const request = createDesktopRestartRequest(debug);
    expect(Object.isFrozen(request)).toBe(true);
    expect(acceptsDesktopRestartRequest(request, debug)).toBe(true);
    expect(acceptsDesktopRestartRequest(request, production)).toBe(false);
    expect(
      acceptsDesktopRestartRequest(request, { ...debug, stateDir: "/other/.debug/userdata" }),
    ).toBe(false);
    expect(acceptsDesktopRestartRequest(createDesktopRestartRequest(production), production)).toBe(
      true,
    );
  });

  it.each([
    undefined,
    null,
    [],
    DESKTOP_RESTART_EXISTING_FLAG,
    {},
    { action: "restart" },
    { ...createDesktopRestartRequest(debug), dataProfile: "unknown" },
    { ...createDesktopRestartRequest(debug), action: "stop-all" },
    { ...createDesktopRestartRequest(debug), protocol: "legacy" },
    { ...createDesktopRestartRequest(debug), extra: true },
    { ...createDesktopRestartRequest(debug), [Symbol("extra")]: true },
    { ...createDesktopRestartRequest(debug), stateDir: "" },
    Object.create(createDesktopRestartRequest(debug)),
  ])("does not admit a missing, legacy or malformed control request", (received) => {
    expect(acceptsDesktopRestartRequest(received, debug)).toBe(false);
  });

  it("does not evaluate received getters or coerce values", () => {
    const getter = vi.fn(() => "restart");
    const received = { ...createDesktopRestartRequest(debug) };
    Object.defineProperty(received, "action", { enumerable: true, get: getter });
    expect(acceptsDesktopRestartRequest(received, debug)).toBe(false);
    expect(getter).not.toHaveBeenCalled();
    const coercion = vi.fn(() => debug.stateDir);
    expect(
      acceptsDesktopRestartRequest(
        { ...createDesktopRestartRequest(debug), stateDir: { toString: coercion } },
        debug,
      ),
    ).toBe(false);
    expect(coercion).not.toHaveBeenCalled();
  });

  it("fails closed on throwing descriptor/shape access", () => {
    const received = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("uninspectable");
        },
      },
    );
    expect(acceptsDesktopRestartRequest(received, debug)).toBe(false);
  });

  it("accepts a finite null-prototype transport record without inherited fields", () => {
    expect(
      acceptsDesktopRestartRequest(
        Object.assign(Object.create(null), createDesktopRestartRequest(debug)),
        debug,
      ),
    ).toBe(true);
  });

  it("strips the control-only request from subsequent native relaunch arguments", () => {
    expect(
      desktopRelaunchArguments([
        "main.cjs",
        DESKTOP_RESTART_EXISTING_FLAG,
        "--cafe-debug",
        DESKTOP_RESTART_EXISTING_FLAG,
      ]),
    ).toEqual(["main.cjs", "--cafe-debug"]);
  });
});
