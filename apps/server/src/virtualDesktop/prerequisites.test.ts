import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkDesktopPrerequisites } from "./prerequisites.ts";
import { executable, nativeHelperReady } from "./nativeClient.ts";

const stat = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", () => ({ stat }));
vi.mock("./nativeClient.ts", () => ({ executable: vi.fn(), nativeHelperReady: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  stat.mockResolvedValue({ isFile: () => true });
  vi.mocked(executable).mockImplementation(async (name) => `/test/bin/${name}`);
  vi.mocked(nativeHelperReady).mockResolvedValue(true);
});

describe("desktop prerequisites", () => {
  it("reports all required components without publishing their paths", async () => {
    expect(await checkDesktopPrerequisites("/private/cafe-desktop-native")).toEqual({
      sway: "installed",
      xwayland: "installed",
      dbus: "installed",
      helper: "installed",
    });
  });
  it.each([
    ["sway", "sway"],
    ["Xwayland", "xwayland"],
    ["dbus-daemon", "dbus"],
  ] as const)("identifies only the missing %s component", async (binary, component) => {
    vi.mocked(executable).mockImplementation(async (name) =>
      name === binary ? null : `/test/bin/${name}`,
    );
    expect(await checkDesktopPrerequisites("/private/helper")).toEqual({
      sway: "installed",
      xwayland: "installed",
      dbus: "installed",
      helper: "installed",
      [component]: "missing",
    });
  });
  it("does not try to run a missing Cafe component", async () => {
    stat.mockRejectedValue(Object.assign(new Error("private path"), { code: "ENOENT" }));
    expect((await checkDesktopPrerequisites("/private/helper")).helper).toBe("missing");
    expect(nativeHelperReady).not.toHaveBeenCalled();
  });
  it("distinguishes loader failure from a missing Cafe component", async () => {
    vi.mocked(nativeHelperReady).mockResolvedValue(false);
    expect((await checkDesktopPrerequisites("/private/helper")).helper).toBe("unavailable");
  });
  it("does not mistake a permissions failure for a missing package or expose errors", async () => {
    stat.mockRejectedValue(Object.assign(new Error("private path"), { code: "EACCES" }));
    const result = await checkDesktopPrerequisites("/private/helper");
    expect(result.helper).toBe("unavailable");
    expect(JSON.stringify(result)).not.toContain("private");
    expect(nativeHelperReady).not.toHaveBeenCalled();
  });
});
