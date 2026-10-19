import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareMacSourceHost, readMacSourceHostUuid } from "./mac-source-host.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function nativeExecutable(): Buffer {
  const bytes = Buffer.alloc(56);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(1, 16);
  bytes.writeUInt32LE(24, 20);
  bytes.writeUInt32LE(0x1b, 32);
  bytes.writeUInt32LE(24, 36);
  bytes.fill(0x42, 40, 56);
  return bytes;
}

function fixture() {
  const homeDirectory = mkdtempSync(join(tmpdir(), "cafe-source-host-"));
  roots.push(homeDirectory);
  const sourcePath = join(homeDirectory, "host.m");
  writeFileSync(sourcePath, "test-owned native host source");
  const calls: { command: string; args: readonly string[] }[] = [];
  let rejectVerification = false;
  const options = {
    homeDirectory,
    architecture: "arm64",
    sourcePath,
    run: (command: string, args: readonly string[]) => {
      calls.push({ command, args });
      if (command === "/usr/bin/nice")
        writeFileSync(args.at(-1)!, nativeExecutable(), { mode: 0o700 });
      return {
        status: rejectVerification && args.includes("--verify") ? 1 : 0,
        stderr: "signature rejected",
      };
    },
  };
  return {
    options,
    calls,
    rejectVerification: () => {
      rejectVerification = true;
    },
  };
}

// The macOS host cache requires POSIX ownership and private mode checks. Windows
// cannot qualify those filesystem semantics; the UUID parser stays portable.
describe.skipIf(process.platform === "win32")("immutable ad hoc source host", () => {
  it("seals once and verifies the same host across mutable source rebuilds", () => {
    const { options, calls } = fixture();
    const app = prepareMacSourceHost(options);
    const executable = join(app, "Contents", "MacOS", "Cafe Code (Debug)");
    const before = readFileSync(executable);
    writeFileSync(join(options.homeDirectory, "replaceable-electron-main.cjs"), "new source build");
    calls.length = 0;
    expect(prepareMacSourceHost(options)).toBe(app);
    expect(readFileSync(executable)).toEqual(before);
    expect(calls).toEqual([
      { command: "/usr/bin/codesign", args: ["--verify", "--deep", "--strict", app] },
    ]);
  });

  it("refuses a native policy change instead of replacing an approved identity", () => {
    const { options, calls } = fixture();
    const app = prepareMacSourceHost(options);
    const before = readFileSync(join(app, "Contents", "Resources", "identity.json"));
    writeFileSync(options.sourcePath, "changed native implementation");
    calls.length = 0;
    expect(() => prepareMacSourceHost(options)).toThrow(/immutable source host identity changed/u);
    expect(calls).toEqual([]);
    expect(readFileSync(join(app, "Contents", "Resources", "identity.json"))).toEqual(before);
  });

  it("refuses a cache whose actual native signature no longer verifies", () => {
    const test = fixture();
    prepareMacSourceHost(test.options);
    test.rejectVerification();
    expect(() => prepareMacSourceHost(test.options)).toThrow("signature rejected");
  });

  it("refuses a substituted native UUID without re-signing it", () => {
    const { options, calls } = fixture();
    const app = prepareMacSourceHost(options);
    const executable = join(app, "Contents", "MacOS", "Cafe Code (Debug)");
    const bytes = readFileSync(executable);
    bytes[40] = 0x43;
    writeFileSync(executable, bytes);
    calls.length = 0;
    expect(() => prepareMacSourceHost(options)).toThrow(/immutable source host identity changed/u);
    expect(calls).toEqual([]);
  });

  it("refuses an alias for the private host namespace", () => {
    const { options } = fixture();
    const parent = join(options.homeDirectory, "Library", "Application Support");
    const other = join(options.homeDirectory, "other-app");
    mkdirSync(parent, { recursive: true });
    mkdirSync(other, { mode: 0o700 });
    symlinkSync(other, join(parent, "Cafe Code Source Hosts"), "dir");
    expect(() => prepareMacSourceHost(options)).toThrow(/private directory/u);
    expect(() => readFileSync(join(other, "v1-arm64", "Cafe Code (Debug).app"))).toThrow();
  });

  it("rejects unsupported architectures and relative home paths before preparation", () => {
    const { options, calls } = fixture();
    expect(() => prepareMacSourceHost({ ...options, architecture: "unknown" })).toThrow(
      /architecture/u,
    );
    expect(() => prepareMacSourceHost({ ...options, homeDirectory: "relative" })).toThrow(
      /absolute/u,
    );
    expect(calls).toEqual([]);
  });
});

describe("native host UUID admission", () => {
  it("reads the native image identity and rejects absent or malformed identities", () => {
    expect(readMacSourceHostUuid(nativeExecutable())).toBe("42".repeat(16));
    for (const edit of [
      (bytes: Buffer) => bytes.writeUInt32LE(0, 0),
      (bytes: Buffer) => bytes.writeUInt32LE(2, 16),
      (bytes: Buffer) => bytes.writeUInt32LE(0xffff, 20),
      (bytes: Buffer) => bytes.writeUInt32LE(8, 32),
      (bytes: Buffer) => bytes.writeUInt32LE(32, 36),
      (bytes: Buffer) => bytes.fill(0, 40),
    ]) {
      const bytes = nativeExecutable();
      edit(bytes);
      expect(() => readMacSourceHostUuid(bytes)).toThrow();
    }
  });
});
