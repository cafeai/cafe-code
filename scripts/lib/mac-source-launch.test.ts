import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { macSourceLaunchArgs } from "./mac-source-launch.ts";

describe("macOS source app launch", () => {
  const root = join(tmpdir(), "Cafe source launch fixture");
  const input = {
    appBundlePath: join(root, "Cafe Code.app"),
    entryPath: join(root, "dist-electron", "main.cjs"),
    stdoutPath: join(root, "source.stdout.log"),
    stderrPath: join(root, "source.stderr.log"),
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
      "--args",
      input.entryPath,
      "--cafe-debug",
      "argument with spaces",
    ]);
  });

  it.each(["appBundlePath", "entryPath", "stdoutPath", "stderrPath"] as const)(
    "rejects a relative %s instead of depending on a LaunchServices working directory",
    (key) => {
      expect(() => macSourceLaunchArgs({ ...input, [key]: "relative path" })).toThrow(
        /must be absolute/u,
      );
    },
  );
});
