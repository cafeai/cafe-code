import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { closeSync, linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  DEFAULT_RESTART_DELAY_MS,
  DEFAULT_RESTART_WAIT_MS,
  buildHelperProcessArgs,
  defaultLaunchCommand,
  parseRestartCafeCodeArgs,
  profileRestartCommand,
  openRestartLog,
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

  it.each(["linux", "win32"] as const)("preserves the Node desktop launch on %s", (platform) => {
    expect(defaultLaunchCommand("node", platform)).toEqual([
      "node",
      "apps/desktop/scripts/start-electron.mjs",
    ]);
  });

  it("relaunches the Mac app through LaunchServices rather than a stale terminal context", () => {
    expect(defaultLaunchCommand("node", "darwin")).toEqual([
      "node",
      "apps/desktop/scripts/start-electron-launchservices.mjs",
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

  it("keeps restart logs inside Debug rather than Production", () => {
    expect(
      resolveRestartLogDir({
        explicitLogDir: undefined,
        env: { CAFE_CODE_HOME: "/tmp/cafe-home" },
        homeDir: "/home/me",
        cwd: "/repo",
      }),
    ).toBe(join("/tmp/cafe-home", ".debug", "restart-logs"));
  });

  it.each(["darwin", "linux", "win32"] as const)(
    "requests the native Debug owner without a global termination command on %s",
    (platform) => {
      expect(
        profileRestartCommand({ launchCommand: undefined, nodePath: "native-node", platform }),
      ).toEqual([...defaultLaunchCommand("native-node", platform), "--cafe-restart-existing"]);
    },
  );

  it("refuses arbitrary replacement commands instead of using broad process discovery", () => {
    expect(() => profileRestartCommand({ launchCommand: ["yarn", "dev:desktop"] })).toThrow(
      "Custom launch commands",
    );
    expect(() => profileRestartCommand({ launchCommand: [] })).toThrow("profile-scoped restart");
  });

  it("honors an explicit log destination without reinterpreting it as a Cafe root", () => {
    expect(
      resolveRestartLogDir({
        explicitLogDir: "logs",
        env: { CAFE_CODE_HOME: "/other" },
        homeDir: "/home/me",
        cwd: "/repo",
      }),
    ).toBe(join("/repo", "logs"));
  });

  it("creates a new private log and never appends through a pre-existing file or hardlink", () => {
    const directory = mkdtempSync(join(tmpdir(), "cafe-restart-log-"));
    try {
      const existing = join(directory, "retained.log");
      const alias = join(directory, "alias.log");
      writeFileSync(existing, "retained synthetic log");
      linkSync(existing, alias);
      expect(() => openRestartLog(existing)).toThrow("private Debug restart log");
      expect(() => openRestartLog(alias)).toThrow("private Debug restart log");
      expect(readFileSync(existing, "utf8")).toBe("retained synthetic log");
      const created = join(directory, "new.log");
      const fd = openRestartLog(created);
      closeSync(fd);
      expect(readFileSync(created, "utf8")).toBe("");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
