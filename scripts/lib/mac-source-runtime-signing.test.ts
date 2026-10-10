import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { signMacSourceRuntime } from "./mac-source-runtime-signing.ts";

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

    const mainIndex = captured.findIndex((args) => args.includes("com.cafeai.cafecode"));
    const main = captured[mainIndex];
    expect(main?.at(-1)).toBe(app);
    expect(main).toContain("--preserve-metadata=entitlements,flags,runtime");
    for (const [name, id] of [
      ["Electron Helper.app", "com.cafeai.cafecode.helper"],
      ["Electron Helper (Renderer).app", "com.cafeai.cafecode.helper.renderer"],
      ["Electron Helper (GPU).app", "com.cafeai.cafecode.helper.gpu"],
      ["Electron Helper (Plugin).app", "com.cafeai.cafecode.helper.plugin"],
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
