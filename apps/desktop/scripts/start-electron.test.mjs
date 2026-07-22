import assert from "node:assert/strict";
import { join, resolve } from "node:path";

import { describe, it } from "vitest";

import {
  buildDesktopChildEnv,
  hasDisplayServer,
  resolveHeadlessServerArgs,
  resolveHeadlessServerCwd,
  resolveHeadlessServerEntrypoint,
  resolveLaunchPlan,
} from "./start-electron.mjs";

// These launcher tests execute on all CI hosts. Build fixture paths with the
// host path implementation because the production launcher receives paths
// from that same host, even when a test selects the Linux display branch.
const fixtureRepositoryRoot = resolve("/repo");
const fixtureDesktopDir = join(fixtureRepositoryRoot, "apps", "desktop");
const fixtureServerEntrypoint = join(fixtureRepositoryRoot, "apps", "server", "dist", "bin.mjs");
const fixtureWorkspaceDir = resolve("/workspace/project");

describe("start-electron launcher", () => {
  it("detects whether Linux has a graphical display available", () => {
    assert.equal(hasDisplayServer({}, "linux"), false);
    assert.equal(hasDisplayServer({ DISPLAY: ":0" }, "linux"), true);
    assert.equal(hasDisplayServer({ WAYLAND_DISPLAY: "wayland-0" }, "linux"), true);
    assert.equal(hasDisplayServer({}, "darwin"), true);
    assert.equal(hasDisplayServer({}, "win32"), true);
  });

  it("strips desktop-only environment before launching a child process", () => {
    const env = buildDesktopChildEnv({
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

  it("routes displayless Linux launches to the headless server", () => {
    const plan = resolveLaunchPlan({
      args: ["--cafe-debug", "--port", "3888"],
      environment: {},
      platform: "linux",
      runtimeDesktopDir: fixtureDesktopDir,
      cwd: fixtureDesktopDir,
      electronPath: () => "/electron",
      serverEntrypoint: fixtureServerEntrypoint,
    });

    assert.equal(plan.type, "headless-server");
    assert.equal(plan.command, process.execPath);
    assert.deepEqual(plan.args, [
      fixtureServerEntrypoint,
      "serve",
      "--mode",
      "desktop",
      "--port",
      "3888",
    ]);
    assert.equal(plan.cwd, fixtureRepositoryRoot);
  });

  it("preserves the original invocation directory for headless server cwd when available", () => {
    assert.equal(
      resolveHeadlessServerCwd({
        cwd: fixtureDesktopDir,
        environment: { INIT_CWD: fixtureWorkspaceDir },
        runtimeDesktopDir: fixtureDesktopDir,
      }),
      fixtureWorkspaceDir,
    );
  });

  it("routes graphical launches to Electron", () => {
    const plan = resolveLaunchPlan({
      args: ["--user-arg"],
      environment: { DISPLAY: ":0" },
      platform: "linux",
      runtimeDesktopDir: fixtureDesktopDir,
      cwd: fixtureDesktopDir,
      electronPath: () => "/electron",
      serverEntrypoint: fixtureServerEntrypoint,
    });

    assert.equal(plan.type, "electron");
    assert.equal(plan.command, "/electron");
    assert.deepEqual(plan.args, ["dist-electron/main.cjs", "--user-arg"]);
    assert.equal(plan.cwd, fixtureDesktopDir);
  });

  it("resolves the staged or source server entrypoint next to the desktop runtime", () => {
    assert.equal(
      resolveHeadlessServerEntrypoint(
        fixtureDesktopDir,
        (path) => path === fixtureServerEntrypoint,
      ),
      fixtureServerEntrypoint,
    );
    assert.equal(
      resolveHeadlessServerEntrypoint(fixtureDesktopDir, () => false),
      undefined,
    );
  });

  it("drops Electron-only switches and defaults to desktop mode for headless serve", () => {
    assert.deepEqual(resolveHeadlessServerArgs(["--debug", "--host", "127.0.0.1"]), [
      "serve",
      "--mode",
      "desktop",
      "--host",
      "127.0.0.1",
    ]);
  });

  it("preserves an explicit server mode argument for headless serve", () => {
    assert.deepEqual(resolveHeadlessServerArgs(["--mode", "web", "--port", "3888"]), [
      "serve",
      "--mode",
      "web",
      "--port",
      "3888",
    ]);
    assert.deepEqual(resolveHeadlessServerArgs(["--mode=web", "--port", "3888"]), [
      "serve",
      "--mode=web",
      "--port",
      "3888",
    ]);
  });
});
