import { tmpdir } from "node:os";
// Host-native path spelling must agree with the existing native file and tool boundary.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { macSourceLaunchArgs, resolveMacSourceConfiguredHome } from "./mac-source-launch.ts";

describe("macOS source app launch", () => {
  const root = join(tmpdir(), "Cafe source launch fixture");
  const input = {
    appBundlePath: join(root, "Cafe Code.app"),
    runtimeBundlePath: join(root, "mutable-runtime", "Cafe Code (Debug).app"),
    entryPath: join(root, "dist-electron", "main.cjs"),
    stdoutPath: join(root, "source.stdout.log"),
    stderrPath: join(root, "source.stderr.log"),
    configuredBaseDir: join(root, "custom Cafe home"),
    pathEnvironment: `${join(root, "pinned node", "bin")}:/literal;$directory=with space/bin:/usr/bin`,
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
      "--env",
      `PATH=${input.pathEnvironment}`,
      "--args",
      "--cafe-source-runtime",
      input.runtimeBundlePath,
      "--cafe-source-entry",
      input.entryPath,
      "--cafe-debug",
      "argument with spaces",
    ]);
  });

  it.each([undefined, ""])(
    "retains the existing fixed environment selection when caller PATH is %j",
    (pathEnvironment) => {
      const args = macSourceLaunchArgs({ ...input, pathEnvironment });
      const environmentArgs = args.slice(0, args.indexOf("--args"));
      expect(
        environmentArgs.flatMap((argument, index) =>
          argument === "--env" ? [environmentArgs[index + 1]] : [],
        ),
      ).toEqual([
        "ELECTRON_RUN_AS_NODE",
        `CAFE_CODE_HOME=${input.configuredBaseDir}`,
        "CAFE_CODE_DATA_PROFILE=debug",
      ]);
      expect(args.slice(args.indexOf("--args") + 1)).toEqual([
        "--cafe-source-runtime",
        input.runtimeBundlePath,
        "--cafe-source-entry",
        input.entryPath,
        ...input.args,
      ]);
    },
  );

  it("accepts a PATH at the UTF-8 byte budget as one literal environment argument", () => {
    const pathEnvironment = "🌱".repeat(4096);
    const args = macSourceLaunchArgs({ ...input, pathEnvironment });
    expect(args.filter((argument) => argument.startsWith("PATH="))).toEqual([
      `PATH=${pathEnvironment}`,
    ]);
  });

  it.each([
    ["NUL", "/safe/bin\0/private-name"],
    ["carriage return", "/safe/bin\r/private-name"],
    ["line feed", "/safe/bin\n/private-name"],
    ["ASCII byte overflow", "x".repeat(16 * 1024 + 1)],
    ["multibyte UTF-8 overflow", "🌱".repeat(4096) + "x"],
    ["non-string runtime value", null],
  ] as const)("refuses %s before launch without echoing caller PATH", (_name, value) => {
    // Keep malformed native-call inputs deliberate; this does not widen the
    // production string contract or coerce values before its own boundary.
    expect(() =>
      macSourceLaunchArgs({ ...input, pathEnvironment: value as unknown as string }),
    ).toThrowError(/^macOS source launch PATH is invalid\.$/u);
  });

  it.each([
    "appBundlePath",
    "runtimeBundlePath",
    "entryPath",
    "stdoutPath",
    "stderrPath",
    "configuredBaseDir",
  ] as const)(
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
