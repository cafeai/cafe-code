import { createHash } from "node:crypto";
// Native fixture boundary: exercise actual filesystem and host-path identity semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
// Native fixture boundary: exercise actual filesystem and host-path identity semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Observe only guard-owned native IO. The real fixture filesystem and crypto
// implementations remain in use; no candidate bundle is ever executed.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    lstatSync: vi.fn(actual.lstatSync),
    openSync: vi.fn(actual.openSync),
  };
});
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, createHash: vi.fn(actual.createHash) };
});

import {
  assertSourceDebugBuild,
  assertSourceDebugDesktopBuilds,
  publishSourceDebugBuildManifest,
  sourceDebugBuildManifestPath,
} from "./sourceDebugBuild.ts";

const temporary: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cafe-source-capability-"));
  temporary.push(root);
  const entry = join(root, "main.cjs");
  const chunk = join(root, "policy.cjs");
  writeFileSync(entry, "require('./policy.cjs');\n");
  writeFileSync(chunk, "exports.profile = 'debug';\n");
  return { root, entry, chunk };
}
afterEach(() => {
  vi.clearAllMocks();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("source Debug build capability", () => {
  it("refuses legacy output without executing it and accepts an exact successful build closure", () => {
    const { entry, chunk } = fixture();
    expect(() => assertSourceDebugBuild(entry, "desktop")).toThrow(
      "Rebuild using yarn build:desktop",
    );
    publishSourceDebugBuildManifest(entry, "desktop", [entry, chunk]);
    expect(() => assertSourceDebugBuild(entry, "desktop")).not.toThrow();
    expect(() => assertSourceDebugBuild(entry, "server")).toThrow(
      "Rebuild using yarn build:desktop",
    );
  });

  it.each(["entry", "chunk"] as const)(
    "refuses changed %s bytes until another successful publication",
    (target) => {
      const files = fixture();
      publishSourceDebugBuildManifest(files.entry, "desktop", [files.entry, files.chunk]);
      writeFileSync(files[target], "legacy production defaults\n");
      expect(() => assertSourceDebugBuild(files.entry, "desktop")).toThrow(
        "Rebuild using yarn build:desktop",
      );
      publishSourceDebugBuildManifest(files.entry, "desktop", [files.entry, files.chunk]);
      expect(() => assertSourceDebugBuild(files.entry, "desktop")).not.toThrow();
    },
  );

  it("refuses an old capability or a path escaping the output directory", () => {
    const { entry, chunk } = fixture();
    publishSourceDebugBuildManifest(entry, "desktop", [entry, chunk]);
    const filename = sourceDebugBuildManifestPath(entry);
    const manifest = JSON.parse(readFileSync(filename, "utf8"));
    writeFileSync(filename, JSON.stringify({ ...manifest, capability: "legacy" }));
    expect(() => assertSourceDebugBuild(entry, "desktop")).toThrow(
      "Rebuild using yarn build:desktop",
    );
    writeFileSync(
      filename,
      JSON.stringify({ ...manifest, files: [{ ...manifest.files[0], file: "../outside.cjs" }] }),
    );
    expect(() => assertSourceDebugBuild(entry, "desktop")).toThrow(
      "Rebuild using yarn build:desktop",
    );
  });

  it("does not publish a successful receipt for absent output", () => {
    const { entry, chunk } = fixture();
    rmSync(chunk);
    expect(() => publishSourceDebugBuildManifest(entry, "desktop", [entry, chunk])).toThrow();
    expect(() => assertSourceDebugBuild(entry, "desktop")).toThrow(
      "Rebuild using yarn build:desktop",
    );
  });

  it("does not attest stale disk bytes as the successful bundler output", () => {
    const { entry, chunk } = fixture();
    expect(() =>
      publishSourceDebugBuildManifest(entry, "desktop", [entry, chunk], {
        [entry]: "new expected entry",
        [chunk]: "new expected chunk",
      }),
    ).toThrow();
    expect(() => assertSourceDebugBuild(entry, "desktop")).toThrow(
      "Rebuild using yarn build:desktop",
    );
  });

  it("rejects an oversized advertised closure before inspecting or hashing any output", () => {
    const { entry, chunk } = fixture();
    publishSourceDebugBuildManifest(entry, "desktop", [entry, chunk]);
    const filename = sourceDebugBuildManifestPath(entry);
    const manifest = JSON.parse(readFileSync(filename, "utf8"));
    // The first real receipt is otherwise valid. A one-pass implementation
    // would hash it before discovering that the complete closure is oversized.
    writeFileSync(
      filename,
      JSON.stringify({
        ...manifest,
        files: [
          manifest.files.find((receipt: { file: string }) => receipt.file === "main.cjs"),
          { file: "large-a.cjs", bytes: 128 * 1024 * 1024, sha256: "a".repeat(64) },
          { file: "large-b.cjs", bytes: 128 * 1024 * 1024, sha256: "b".repeat(64) },
        ],
      }),
    );
    vi.clearAllMocks();
    expect(() => assertSourceDebugBuild(entry, "desktop")).toThrow(
      "Rebuild using yarn build:desktop",
    );
    expect(vi.mocked(lstatSync).mock.calls.map(([file]) => file)).toEqual([filename]);
    expect(vi.mocked(openSync).mock.calls.map(([file]) => file)).toEqual([filename]);
    expect(createHash).not.toHaveBeenCalled();
  });

  it("applies the aggregate bound to publisher metadata before reading content", () => {
    const { root, entry, chunk } = fixture();
    const extra = join(root, "extra.cjs");
    const nativeMetadata = lstatSync(entry, { bigint: true });
    const sizedMetadata = (size: bigint) =>
      Object.assign(Object.create(Object.getPrototypeOf(nativeMetadata)), nativeMetadata, {
        size,
      }) as typeof nativeMetadata;
    vi.clearAllMocks();
    vi.mocked(lstatSync)
      .mockReturnValueOnce(sizedMetadata(128n * 1024n * 1024n))
      .mockReturnValueOnce(sizedMetadata(128n * 1024n * 1024n))
      .mockReturnValueOnce(sizedMetadata(1n));
    expect(() => publishSourceDebugBuildManifest(entry, "desktop", [entry, chunk, extra])).toThrow(
      "Rebuild using yarn build:desktop",
    );
    expect(openSync).not.toHaveBeenCalled();
    expect(createHash).not.toHaveBeenCalled();
  });

  it("preflights actual sizes for the complete closure before hashing earlier outputs", () => {
    const { entry, chunk } = fixture();
    publishSourceDebugBuildManifest(entry, "desktop", [entry, chunk]);
    const filename = sourceDebugBuildManifestPath(entry);
    const manifest = JSON.parse(readFileSync(filename, "utf8"));
    writeFileSync(
      filename,
      JSON.stringify({
        ...manifest,
        files: manifest.files.map((receipt: { file: string; bytes: number }) =>
          receipt.file === "policy.cjs" ? { ...receipt, bytes: receipt.bytes + 1 } : receipt,
        ),
      }),
    );
    vi.clearAllMocks();
    expect(() => assertSourceDebugBuild(entry, "desktop")).toThrow(
      "Rebuild using yarn build:desktop",
    );
    expect(vi.mocked(openSync).mock.calls.map(([file]) => file)).toEqual([filename]);
    expect(createHash).not.toHaveBeenCalled();
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER, 128 * 1024 * 1024 + 1])(
    "rejects invalid or over-budget receipt byte count %s before output IO",
    (bytes) => {
      const { entry, chunk } = fixture();
      publishSourceDebugBuildManifest(entry, "desktop", [entry, chunk]);
      const filename = sourceDebugBuildManifestPath(entry);
      const manifest = JSON.parse(readFileSync(filename, "utf8"));
      writeFileSync(
        filename,
        JSON.stringify({
          ...manifest,
          files: manifest.files.map((receipt: object) => ({ ...receipt, bytes })),
        }),
      );
      vi.clearAllMocks();
      expect(() => assertSourceDebugBuild(entry, "desktop")).toThrow(
        "Rebuild using yarn build:desktop",
      );
      expect(vi.mocked(lstatSync).mock.calls.map(([file]) => file)).toEqual([filename]);
      expect(vi.mocked(openSync).mock.calls.map(([file]) => file)).toEqual([filename]);
      expect(createHash).not.toHaveBeenCalled();
    },
  );

  it.each(["manifest", "receipt"] as const)(
    "refuses unexpected %s fields before candidate content IO",
    (target) => {
      const { entry, chunk } = fixture();
      publishSourceDebugBuildManifest(entry, "desktop", [entry, chunk]);
      const filename = sourceDebugBuildManifestPath(entry);
      const manifest = JSON.parse(readFileSync(filename, "utf8"));
      writeFileSync(
        filename,
        JSON.stringify(
          target === "manifest"
            ? { ...manifest, extra: true }
            : {
                ...manifest,
                files: manifest.files.map((receipt: object) => ({ ...receipt, extra: true })),
              },
        ),
      );
      vi.clearAllMocks();
      expect(() => assertSourceDebugBuild(entry, "desktop")).toThrow(
        "Rebuild using yarn build:desktop",
      );
      expect(vi.mocked(openSync).mock.calls.map(([file]) => file)).toEqual([filename]);
      expect(createHash).not.toHaveBeenCalled();
    },
  );

  it("requires both desktop and backend capabilities before source startup", () => {
    const { root } = fixture();
    const desktop = join(root, "apps", "desktop");
    const main = join(desktop, "dist-electron", "main.cjs");
    const server = join(root, "apps", "server", "dist", "bin.mjs");
    mkdirSync(join(desktop, "dist-electron"), { recursive: true });
    mkdirSync(join(root, "apps", "server", "dist"), { recursive: true });
    writeFileSync(main, "new desktop\n");
    writeFileSync(server, "new server\n");
    publishSourceDebugBuildManifest(main, "desktop", [main]);
    expect(() => assertSourceDebugDesktopBuilds(desktop)).toThrow(
      "Rebuild using yarn build:desktop",
    );
    publishSourceDebugBuildManifest(server, "server", [server]);
    expect(() => assertSourceDebugDesktopBuilds(desktop)).not.toThrow();
    writeFileSync(server, "old provider defaults\n");
    expect(() => assertSourceDebugDesktopBuilds(desktop)).toThrow(
      "Rebuild using yarn build:desktop",
    );
  });
});
