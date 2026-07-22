import { describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  DEFAULT_RESTART_DELAY_MS,
  DEFAULT_RESTART_WAIT_MS,
  buildHelperProcessArgs,
  defaultLaunchCommand,
  parseRestartCafeCodeArgs,
  resolveRestartLogDir,
} from "./restart-cafe-code.ts";

describe("restart-cafe-code", () => {
  it("uses safe defaults for a scheduled desktop restart", () => {
    expect(parseRestartCafeCodeArgs([])).toEqual({
      runHelper: false,
      waitMs: DEFAULT_RESTART_WAIT_MS,
      restartDelayMs: DEFAULT_RESTART_DELAY_MS,
      logDir: undefined,
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
        "yarn",
        "dev:desktop",
      ]),
    ).toMatchObject({
      waitMs: 25,
      restartDelayMs: 50,
      launchCommand: ["yarn", "dev:desktop"],
    });
  });

  it("rejects an empty explicit launch command", () => {
    expect(() => parseRestartCafeCodeArgs(["--"])).toThrow("Expected a launch command");
  });

  it("builds the default desktop launch command through Node", () => {
    expect(defaultLaunchCommand("/opt/bin/node")).toEqual([
      "/opt/bin/node",
      "apps/desktop/scripts/start-electron.mjs",
    ]);
  });

  it("keeps helper args structured and appends custom launch argv only after --", () => {
    expect(
      buildHelperProcessArgs({
        scriptPath: "/repo/scripts/restart-cafe-code.ts",
        waitMs: 10,
        restartDelayMs: 20,
        logDir: "/tmp/logs",
        launchCommand: ["yarn", "dev:desktop"],
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
      "--",
      "yarn",
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
    ).toBe(join("/tmp/cafe-home", "restart-logs"));
  });
});
