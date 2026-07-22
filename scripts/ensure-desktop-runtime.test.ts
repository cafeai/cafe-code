import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ensureNodePtySpawnHelperExecutable } from "./ensure-desktop-runtime.ts";

const temporaryDirectories: string[] = [];

function makeNodePtyFixture(): { readonly packageRoot: string; readonly helperPath: string } {
  const packageRoot = mkdtempSync(join(tmpdir(), "cafecode-node-pty-install-"));
  temporaryDirectories.push(packageRoot);
  const nativeDirectory = join(packageRoot, "prebuilds", "darwin-arm64");
  mkdirSync(nativeDirectory, { recursive: true });
  writeFileSync(join(nativeDirectory, "pty.node"), "native fixture");
  const helperPath = join(nativeDirectory, "spawn-helper");
  writeFileSync(helperPath, "helper fixture", { mode: 0o644 });
  chmodSync(helperPath, 0o644);
  return { packageRoot, helperPath };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("ensureNodePtySpawnHelperExecutable", () => {
  it.skipIf(process.platform === "win32")(
    "restores executable permissions on the selected macOS helper",
    () => {
      const fixture = makeNodePtyFixture();

      expect(ensureNodePtySpawnHelperExecutable(fixture.packageRoot, "darwin", "arm64")).toBe(
        fixture.helperPath,
      );
      expect(lstatSync(fixture.helperPath).mode & 0o111).toBe(0o111);
    },
  );

  it.skipIf(process.platform === "win32")("refuses to chmod a symlinked helper", () => {
    const fixture = makeNodePtyFixture();
    const symlinkTarget = join(fixture.packageRoot, "untrusted-target");
    writeFileSync(symlinkTarget, "do not chmod", { mode: 0o600 });
    rmSync(fixture.helperPath);
    symlinkSync(symlinkTarget, fixture.helperPath);

    expect(() =>
      ensureNodePtySpawnHelperExecutable(fixture.packageRoot, "darwin", "arm64"),
    ).toThrow(/missing or is not a safe regular file/u);
    expect(lstatSync(symlinkTarget).mode & 0o777).toBe(0o600);
  });

  it("does not require a POSIX helper on Windows", () => {
    expect(ensureNodePtySpawnHelperExecutable("unused", "win32", "x64")).toBeNull();
  });

  it("does not require the macOS-only helper on Linux", () => {
    expect(ensureNodePtySpawnHelperExecutable("unused", "linux", "x64")).toBeNull();
  });
});
