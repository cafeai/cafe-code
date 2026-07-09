import { describe, expect, it } from "vitest";

import {
  DEFAULT_RESTART_DELAY_MS,
  DEFAULT_RESTART_WAIT_MS,
  buildHelperProcessArgs,
  defaultLaunchCommand,
  parseRestartCafeCodeArgs,
  resolveBunPath,
  resolveRestartLogDir,
} from "./restart-cafe-code.ts";

describe("restart-cafe-code", () => {
  it("uses safe defaults for a scheduled desktop restart", () => {
    expect(parseRestartCafeCodeArgs([])).toEqual({
      runHelper: false,
      waitMs: DEFAULT_RESTART_WAIT_MS,
      restartDelayMs: DEFAULT_RESTART_DELAY_MS,
      logDir: undefined,
      bunPath: undefined,
      launchCommand: undefined,
      dryRun: false,
      help: false,
    });
  });

  it("preserves an explicit launch command after the separator", () => {
    expect(
      parseRestartCafeCodeArgs([
        "--wait-ms=25",
        "--restart-delay-ms",
        "50",
        "--",
        "bun",
        "run",
        "dev:desktop",
      ]),
    ).toMatchObject({
      waitMs: 25,
      restartDelayMs: 50,
      launchCommand: ["bun", "run", "dev:desktop"],
    });
  });

  it("rejects an empty explicit launch command", () => {
    expect(() => parseRestartCafeCodeArgs(["--"])).toThrow("Expected a launch command");
  });

  it("resolves bun from the current package-manager executable when available", () => {
    expect(resolveBunPath({ npm_execpath: "/opt/bin/bun" }, "linux")).toBe("/opt/bin/bun");
    expect(resolveBunPath({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "win32")).toBe(
      "C:\\Users\\me\\AppData\\Roaming\\npm\\bun.cmd",
    );
  });

  it("builds the default desktop launch command through bun", () => {
    expect(defaultLaunchCommand("/opt/bin/bun")).toEqual([
      "/opt/bin/bun",
      "run",
      "--cwd",
      "apps/desktop",
      "start",
    ]);
  });

  it("keeps helper args structured and appends custom launch argv only after --", () => {
    expect(
      buildHelperProcessArgs({
        scriptPath: "/repo/scripts/restart-cafe-code.ts",
        waitMs: 10,
        restartDelayMs: 20,
        logDir: "/tmp/logs",
        bunPath: "/opt/bin/bun",
        launchCommand: ["bun", "run", "dev:desktop"],
      }),
    ).toEqual([
      "/repo/scripts/restart-cafe-code.ts",
      "--run-helper",
      "--wait-ms",
      "10",
      "--restart-delay-ms",
      "20",
      "--log-dir",
      "/tmp/logs",
      "--bun-path",
      "/opt/bin/bun",
      "--",
      "bun",
      "run",
      "dev:desktop",
    ]);
  });

  it("uses Cafe Code home for restart logs by default", () => {
    expect(
      resolveRestartLogDir({
        explicitLogDir: undefined,
        env: { CAFE_CODE_HOME: "/tmp/cafe-home" },
        homeDir: "/home/me",
        cwd: "/repo",
      }),
    ).toBe("/tmp/cafe-home/restart-logs");
  });
});
