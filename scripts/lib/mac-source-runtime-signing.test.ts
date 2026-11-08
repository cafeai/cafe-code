// Native checkout/fixture IO retains its existing descriptor, identity and lifetime semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// Host-native path spelling must agree with the existing native file and tool boundary.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MAC_SOURCE_APP_NAME,
  MAC_SOURCE_BUNDLE_IDENTIFIER,
  resolveMacSourceRuntimeDirectory,
  signMacSourceRuntime,
  registerMacSourceRuntime,
  resolveMacSourceRuntimeBundleIdentifier,
} from "./mac-source-runtime-signing.ts";

const directories: string[] = [];

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "cafe-source-signing-"));
  directories.push(root);
  const app = join(root, "Cafe Code.app");
  const frameworks = join(app, "Contents", "Frameworks");
  mkdirSync(frameworks, { recursive: true });
  for (const name of [
    "Electron Framework.framework",
    "ReactiveObjC.framework",
    "Electron Helper.app",
    "Electron Helper (Renderer).app",
    "Electron Helper (GPU).app",
    "Electron Helper (Plugin).app",
  ]) {
    mkdirSync(join(frameworks, name));
  }
  writeFileSync(join(frameworks, "unrelated.framework"), "regular file, not a framework bundle");
  return { app, frameworks };
}

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("macOS source runtime activation registration", () => {
  it("gives each canonical checkout a stable separate runtime identity and binds every signature to it", () => {
    const { app: first } = makeFixture();
    const { app: second } = makeFixture();
    const identifier = resolveMacSourceRuntimeBundleIdentifier(first);
    expect(identifier).toMatch(/^com\.cafeai\.cafecode\.debug\.runtime\.[a-f0-9]{24}$/u);
    expect(resolveMacSourceRuntimeBundleIdentifier(join(first, "."))).toBe(identifier);
    expect(resolveMacSourceRuntimeBundleIdentifier(second)).not.toBe(identifier);
    const signatures: string[][] = [];
    signMacSourceRuntime(first, {
      bundleIdentifier: identifier,
      run: (args) => {
        signatures.push([...args]);
        return { status: 0, stderr: "" };
      },
    });
    expect(signatures.some((args) => args.includes(identifier))).toBe(true);
    for (const suffix of ["helper", "helper.renderer", "helper.gpu", "helper.plugin"])
      expect(signatures.some((args) => args.includes(`${identifier}.${suffix}`))).toBe(true);
    const captured: string[][] = [];
    registerMacSourceRuntime(first, {
      bundleIdentifier: identifier,
      run: (_command, args) => {
        captured.push([...args]);
        return { status: 0, stderr: "" };
      },
    });
    expect(captured[0]).toContain(`=identifier "${identifier}"`);
    for (const bad of ["com.cafeai.cafecode", "com.github.Electron", `${identifier}X`]) {
      expect(() =>
        signMacSourceRuntime(first, {
          bundleIdentifier: bad,
          run: () => {
            throw new Error("must not run");
          },
        }),
      ).toThrow("Invalid source runtime bundle identity.");
      expect(() =>
        registerMacSourceRuntime(first, {
          bundleIdentifier: bad,
          run: () => {
            throw new Error("must not run");
          },
        }),
      ).toThrow("Invalid source runtime bundle identity.");
    }
  });

  it("verifies the exact Debug identity before registering only the selected app", () => {
    const { app } = makeFixture();
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const run = (command: string, args: readonly string[]) => {
      calls.push({ command, args });
      return { status: 0, stderr: "" };
    };
    registerMacSourceRuntime(app, { run });
    expect(calls).toEqual([
      {
        command: "/usr/bin/codesign",
        args: [
          "--verify",
          "--deep",
          "--strict",
          "-R",
          '=identifier "com.cafeai.cafecode.debug"',
          app,
        ],
      },
      {
        command:
          "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
        args: ["-f", app],
      },
    ]);
  });

  it("refreshes registration when a previously prepared copy is selected again", () => {
    const { app: first } = makeFixture();
    const { app: second } = makeFixture();
    const registered: string[] = [];
    const run = (command: string, args: readonly string[]) => {
      if (command.endsWith("/lsregister")) registered.push(args[1]!);
      return { status: 0, stderr: "" };
    };
    for (const app of [first, second, first]) registerMacSourceRuntime(app, { run });
    expect(registered).toEqual([first, second, first]);
  });

  it("refuses relative paths and failed identity checks before changing registration", () => {
    const { app } = makeFixture();
    const calls: string[] = [];
    const run = (command: string) => {
      calls.push(command);
      return { status: 1, stderr: "untrusted received output" };
    };
    expect(() => registerMacSourceRuntime("relative.app", { run })).toThrow(/absolute/u);
    expect(calls).toEqual([]);
    expect(() => registerMacSourceRuntime(app, { run })).toThrow(/invalid Debug app signature/u);
    expect(calls).toEqual(["/usr/bin/codesign"]);
  });

  it("reports a fixed failure without forwarding native output or coercing thrown errors", () => {
    const { app } = makeFixture();
    const opaque = {
      toString: () => {
        throw new Error("must not coerce");
      },
    };
    for (const fail of [
      () => ({ status: 1, stderr: "PRIVATE_NATIVE_OUTPUT" }),
      () => {
        throw opaque;
      },
    ]) {
      expect(() =>
        registerMacSourceRuntime(app, {
          run: (command) => (command.endsWith("/codesign") ? { status: 0, stderr: "" } : fail()),
        }),
      ).toThrow("Could not register the source Cafe Code app for native activation.");
    }
  });
});

describe("macOS source runtime signing", () => {
  it("binds the main app and helpers to their Cafe identities and preserves execution metadata", () => {
    const { app, frameworks } = makeFixture();
    const captured: string[][] = [];
    signMacSourceRuntime(app, {
      run: (args) => {
        captured.push([...args]);
        return { status: 0, stderr: "" };
      },
    });

    const mainIndex = captured.findIndex((args) => args.includes("com.cafeai.cafecode.debug"));
    const main = captured[mainIndex];
    expect(main?.at(-1)).toBe(app);
    expect(main).toContain("--preserve-metadata=entitlements,flags,runtime");
    for (const [name, id] of [
      ["Electron Helper.app", "com.cafeai.cafecode.debug.helper"],
      ["Electron Helper (Renderer).app", "com.cafeai.cafecode.debug.helper.renderer"],
      ["Electron Helper (GPU).app", "com.cafeai.cafecode.debug.helper.gpu"],
      ["Electron Helper (Plugin).app", "com.cafeai.cafecode.debug.helper.plugin"],
    ] as const) {
      const callIndex = captured.findIndex((args) => args.includes(id));
      const call = captured[callIndex];
      expect(call?.at(-1)).toBe(join(frameworks, name));
      expect(call).toContain("--preserve-metadata=entitlements,flags,runtime");
      expect(callIndex).toBeLessThan(mainIndex);
    }
    const framework = captured.find(
      (args) => args.at(-1) === join(frameworks, "Electron Framework.framework"),
    );
    expect(framework).toContain("--preserve-metadata=identifier,entitlements,flags,runtime");
    expect(framework).not.toContain("--identifier");
    expect(captured.some((args) => args.at(-1)?.endsWith("unrelated.framework"))).toBe(false);
    expect(captured.at(-1)).toEqual(["--verify", "--deep", "--strict", app]);
    expect(captured.some((args) => args.includes("com.cafeai.cafecode"))).toBe(false);
    expect(MAC_SOURCE_APP_NAME).toBe("Cafe Code (Debug)");
    expect(MAC_SOURCE_BUNDLE_IDENTIFIER).toBe("com.cafeai.cafecode.debug");
    const debugCache = resolveMacSourceRuntimeDirectory(app);
    expect(debugCache).toBe(join(app, ".electron-runtime", "debug-runtime-v2"));
    expect(debugCache).not.toBe(join(app, ".electron-runtime"));
  });

  it("stops before sealing the parent when a nested signature fails", () => {
    const { app } = makeFixture();
    const calls: string[][] = [];
    expect(() =>
      signMacSourceRuntime(app, {
        run: (args) => {
          calls.push([...args]);
          return { status: 1, stderr: "fixture signing failure" };
        },
      }),
    ).toThrow(/source framework.*fixture signing failure/u);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.at(-1)).not.toBe(app);
  });

  it("refuses to publish a runtime whose final verification fails", () => {
    const { app } = makeFixture();
    expect(() =>
      signMacSourceRuntime(app, {
        run: (args) => ({
          status: args.includes("--verify") ? 1 : 0,
          stderr: args.includes("--verify") ? "invalid nested signature" : "",
        }),
      }),
    ).toThrow(/verify source Cafe Code app.*invalid nested signature/u);
  });
});
