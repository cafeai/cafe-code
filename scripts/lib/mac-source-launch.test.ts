import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { macSourceLaunchArgs, resolveMacSourceConfiguredHome } from "./mac-source-launch.ts";

describe("macOS source app launch", () => {
  const root = join(tmpdir(), "Cafe source launch fixture");
  const input = {
    appBundlePath: join(root, "Cafe Code.app"),
    entryPath: join(root, "dist-electron", "main.cjs"),
    stdoutPath: join(root, "source.stdout.log"),
    stderrPath: join(root, "source.stderr.log"),
    configuredBaseDir: join(root, "custom Cafe home"),
    args: ["--cafe-debug", "argument with spaces"],
  };

  it("keeps source paths and app arguments structured, and clears inherited Node-only mode", () => {
    expect(macSourceLaunchArgs(input)).toEqual([
      "-n",
      "-a",
      input.appBundlePath,
      "--stdout",
      input.stdoutPath,
      "--stderr",
      input.stderrPath,
      "--env",
      "ELECTRON_RUN_AS_NODE",
      "--env",
      `CAFE_CODE_HOME=${input.configuredBaseDir}`,
      "--env",
      "CAFE_CODE_DATA_PROFILE=debug",
      "--args",
      input.entryPath,
      "--cafe-debug",
      "argument with spaces",
    ]);
  });

  it.each(["appBundlePath", "entryPath", "stdoutPath", "stderrPath", "configuredBaseDir"] as const)(
    "rejects a relative %s instead of depending on a LaunchServices working directory",
    (key) => {
      expect(() => macSourceLaunchArgs({ ...input, [key]: "relative path" })).toThrow(
        /must be absolute/u,
      );
    },
  );

  it("fixes a configured root to the same absolute spelling before changing launch cwd", () => {
    const homeDirectory = join(root, "home");
    expect(resolveMacSourceConfiguredHome(undefined, homeDirectory)).toBe(
      join(homeDirectory, ".cafe-code"),
    );
    expect(resolveMacSourceConfiguredHome("~", homeDirectory)).toBe(homeDirectory);
    expect(resolveMacSourceConfiguredHome(" ~/Cafe data ", homeDirectory)).toBe(
      join(homeDirectory, "Cafe data"),
    );
    expect(resolveMacSourceConfiguredHome("~\\Cafe data", homeDirectory)).toBe(
      join(homeDirectory, "Cafe data"),
    );
    expect(resolveMacSourceConfiguredHome("fixture/../Cafe data", homeDirectory)).toBe(
      resolve("fixture/../Cafe data"),
    );
  });
});
