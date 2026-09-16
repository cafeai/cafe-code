import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn<(...args: unknown[]) => string>(),
  desktopSdlPrefix: vi.fn<() => Promise<string>>(),
  mkdirSync: vi.fn(),
  chmodSync: vi.fn(),
  copyFileSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execFileSync: mocks.execFileSync }));
vi.mock("node:fs", () => ({
  mkdirSync: mocks.mkdirSync,
  chmodSync: mocks.chmodSync,
  copyFileSync: mocks.copyFileSync,
}));
vi.mock("./lib/desktopSdl.ts", () => ({ desktopSdlPrefix: mocks.desktopSdlPrefix }));

import { buildVirtualDesktopNative } from "./build-virtual-desktop.ts";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.execFileSync.mockReturnValue("-Ifixture -lfixture");
  mocks.desktopSdlPrefix.mockResolvedValue("fixture-sdl-prefix");
});

describe("Linux native desktop build prerequisites", () => {
  it.each(["missing package", "missing pkg-config", "timed-out pkg-config"])(
    "stops before downloading SDL or creating outputs when the preflight fails: %s",
    async (failure) => {
      mocks.execFileSync.mockImplementationOnce(() => {
        throw new Error(`untrusted subprocess details: ${failure}`);
      });

      await expect(buildVirtualDesktopNative("linux")).rejects.toThrow(
        /Could not verify Linux virtual-desktop build prerequisites.*libdrm-dev/,
      );
      expect(mocks.execFileSync).toHaveBeenCalledExactlyOnceWith(
        "pkg-config",
        expect.arrayContaining(["--exists", "libdrm", "gbm", "gio-2.0"]),
        { shell: false, stdio: "ignore", timeout: 10_000, killSignal: "SIGKILL" },
      );
      expect(mocks.desktopSdlPrefix).not.toHaveBeenCalled();
      expect(mocks.mkdirSync).not.toHaveBeenCalled();
      expect(mocks.chmodSync).not.toHaveBeenCalled();
      expect(mocks.copyFileSync).not.toHaveBeenCalled();
    },
  );

  it("checks every host package before SDL and preserves the compile/link package order", async () => {
    await buildVirtualDesktopNative("linux");

    const preflight = mocks.execFileSync.mock.calls[0];
    const flags = mocks.execFileSync.mock.calls[1];
    expect(preflight?.[0]).toBe("pkg-config");
    expect(flags?.[0]).toBe("pkg-config");
    const linkPackages = [
      "wayland-client",
      "sdl3",
      "libpng",
      "json-c",
      "xkbcommon",
      "xtst",
      "x11",
      "gbm",
      "egl",
      "glesv2",
      "pangocairo",
      "gio-2.0",
    ];
    expect(flags?.[1]).toEqual(["--static", "--cflags", "--libs", ...linkPackages]);
    expect(preflight?.[1]).toEqual([
      "--exists",
      ...linkPackages.filter((name) => name !== "sdl3"),
      "libdrm",
    ]);
    const sdlOrder = mocks.desktopSdlPrefix.mock.invocationCallOrder[0];
    expect(mocks.execFileSync.mock.invocationCallOrder[0]).toBeLessThan(sdlOrder!);
    expect(mocks.execFileSync.mock.invocationCallOrder[1]).toBeGreaterThan(sdlOrder!);
    expect(mocks.chmodSync).toHaveBeenCalledWith(expect.any(String), 0o755);
  });

  it.each(["darwin", "win32"] as const)("remains a no-op on %s", async (platform) => {
    await buildVirtualDesktopNative(platform);

    expect(mocks.execFileSync).not.toHaveBeenCalled();
    expect(mocks.desktopSdlPrefix).not.toHaveBeenCalled();
    expect(mocks.mkdirSync).not.toHaveBeenCalled();
    expect(mocks.chmodSync).not.toHaveBeenCalled();
    expect(mocks.copyFileSync).not.toHaveBeenCalled();
  });
});
