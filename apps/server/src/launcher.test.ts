// @effect-diagnostics nodeBuiltinImport:off
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assert, describe, it } from "@effect/vitest";

import { buildDesktopLaunchEnv, isCliEntrypoint, resolveLaunchAction } from "./launcher.ts";

describe("launcher", () => {
  it("routes bare npx execution to the Electron desktop launcher", () => {
    assert.deepEqual(resolveLaunchAction([]), { type: "desktop", args: [] });
    assert.deepEqual(resolveLaunchAction(["--cafe-debug"]), {
      type: "desktop",
      args: ["--cafe-debug"],
    });
  });

  it("recognizes npm bin symlinks as direct launcher execution", () => {
    const launcherPath = fileURLToPath(new URL("./launcher.ts", import.meta.url));
    const testDir = mkdtempSync(join(tmpdir(), "cafe-code-launcher-"));
    const symlinkPath = join(testDir, "cafe-code");

    try {
      symlinkSync(launcherPath, symlinkPath);
      assert.equal(
        isCliEntrypoint(symlinkPath, pathToFileURL(realpathSync(launcherPath)).href),
        true,
      );
    } finally {
      rmSync(testDir, { force: true, recursive: true });
    }
  });

  it("routes server-only usage explicitly", () => {
    assert.deepEqual(resolveLaunchAction(["--server", "serve", "--port", "3773"]), {
      type: "server",
      args: ["serve", "--port", "3773"],
    });
    assert.deepEqual(resolveLaunchAction(["serve", "--port", "3773"]), {
      type: "server",
      args: ["serve", "--port", "3773"],
    });
    assert.deepEqual(resolveLaunchAction(["auth", "pairing", "create"]), {
      type: "server",
      args: ["auth", "pairing", "create"],
    });
    assert.deepEqual(resolveLaunchAction(["killall"]), {
      type: "server",
      args: ["killall"],
    });
  });

  it("keeps help and version local to the launcher", () => {
    assert.deepEqual(resolveLaunchAction(["--help"]), { type: "help" });
    assert.deepEqual(resolveLaunchAction(["-h"]), { type: "help" });
    assert.deepEqual(resolveLaunchAction(["--version"]), { type: "version" });
    assert.deepEqual(resolveLaunchAction(["-v"]), { type: "version" });
  });

  it("strips environment variables that can make Electron behave like a web/dev runner", () => {
    const env = buildDesktopLaunchEnv({
      ELECTRON_RUN_AS_NODE: "1",
      CAFE_CODE_DESKTOP_DEV: "1",
      VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
      CAFE_CODE_DEV_URL: "http://127.0.0.1:5173",
      PATH: "/bin",
    });

    assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(env.CAFE_CODE_DESKTOP_DEV, undefined);
    assert.equal(env.VITE_DEV_SERVER_URL, undefined);
    assert.equal(env.CAFE_CODE_DEV_URL, undefined);
    assert.equal(env.PATH, "/bin");
  });
});
