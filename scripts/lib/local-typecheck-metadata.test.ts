// These exact temporary files qualify native no-follow/identity retirement;
// synthetic generated metadata never reads checkout compiler output or secrets.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import {
  closeSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi, type TestContext } from "vitest";
import {
  LocalTypecheckMetadataError,
  retireLocalTypecheckMetadata,
} from "./local-typecheck-metadata.ts";

vi.mock("node:fs/promises", async (original) => {
  const native = await original<typeof import("node:fs/promises")>();
  return { ...native, rename: vi.fn(native.rename) };
});

const encode = Schema.encodeSync(Schema.UnknownFromJsonString);
const generated = encode({
  fileNames: ["source.ts"],
  fileInfos: [{ version: "a".repeat(64), affectsGlobalScope: true }],
  options: { noEmit: true, incremental: true },
  version: "5.9.3",
});

function fixture(context: TestContext) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "cafe-typecheck-metadata-")));
  const path = join(cwd, "tsconfig.tsbuildinfo");
  const pending: Promise<void>[] = [];
  context.onTestFinished(async () => {
    // Join the exact admitted retirement even after a hard test timeout before
    // deleting only this fixture-created namespace, including retained evidence.
    await Promise.allSettled(pending);
    rmSync(cwd, { recursive: true, force: true });
  });
  return {
    cwd,
    path,
    retire: () => {
      const run = retireLocalTypecheckMetadata({ cwd });
      pending.push(run);
      void run.catch(() => {}); // The original caller still observes its failure.
      return run;
    },
  };
}

describe.skipIf(process.platform === "win32")("default local compiler metadata retirement", () => {
  it("retires only recognized default generated metadata and retains source/custom metadata", async (context) => {
    const owned = fixture(context);
    writeFileSync(owned.path, generated, { mode: 0o600 });
    writeFileSync(join(owned.cwd, "custom.tsbuildinfo"), generated);
    writeFileSync(join(owned.cwd, "source.ts"), "export const preserved = true;\n");
    await owned.retire();
    expect(readdirSync(owned.cwd).sort()).toEqual(["custom.tsbuildinfo", "source.ts"]);
    expect(readFileSync(join(owned.cwd, "custom.tsbuildinfo"), "utf8")).toBe(generated);
    expect(readFileSync(join(owned.cwd, "source.ts"), "utf8")).toBe(
      "export const preserved = true;\n",
    );
  });

  it("does not create a quarantine or alter other files when default metadata is absent", async (context) => {
    const owned = fixture(context);
    const custom = join(owned.cwd, "custom.tsbuildinfo");
    writeFileSync(custom, "unknown custom bytes");
    const before = lstatSync(custom, { bigint: true });
    await owned.retire();
    expect(readdirSync(owned.cwd)).toEqual(["custom.tsbuildinfo"]);
    const after = lstatSync(custom, { bigint: true });
    expect([after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs]).toEqual([
      before.dev,
      before.ino,
      before.size,
      before.mtimeNs,
      before.ctimeNs,
    ]);
  });

  it("preserves malformed, unknown-version and mismatched generated shapes", async (context) => {
    const owned = fixture(context);
    for (const bytes of [
      "not JSON",
      encode({}),
      encode({ version: "5.9.3", fileNames: [], fileInfos: [] }),
      encode({ version: "5.9.2", fileNames: ["source.ts"], fileInfos: ["hash"] }),
      encode({ version: "5.9.3", fileNames: ["source.ts"], fileInfos: [] }),
      encode({ version: "5.9.3", fileNames: ["source.ts"], fileInfos: [{}] }),
    ]) {
      writeFileSync(owned.path, bytes, { mode: 0o600 });
      await expect(owned.retire()).rejects.toBeInstanceOf(LocalTypecheckMetadataError);
      expect(readFileSync(owned.path, "utf8")).toBe(bytes);
      expect(readdirSync(owned.cwd)).toEqual(["tsconfig.tsbuildinfo"]);
    }
  });

  it("refuses a symlink and a multiply-linked file without removing their contents", async (context) => {
    const owned = fixture(context);
    const target = join(owned.cwd, "preserved");
    writeFileSync(target, generated, { mode: 0o600 });
    symlinkSync(target, owned.path);
    await expect(owned.retire()).rejects.toBeInstanceOf(LocalTypecheckMetadataError);
    expect(lstatSync(owned.path).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(generated);
    rmSync(owned.path);
    linkSync(target, owned.path);
    await expect(owned.retire()).rejects.toBeInstanceOf(LocalTypecheckMetadataError);
    expect(lstatSync(owned.path).nlink).toBe(2);
    expect(readFileSync(owned.path, "utf8")).toBe(generated);
    expect(readFileSync(target, "utf8")).toBe(generated);
  });

  it("refuses oversized metadata before reading its body and rejects noncanonical cwd", async (context) => {
    const owned = fixture(context);
    const file = openSync(owned.path, "wx", 0o600);
    try {
      ftruncateSync(file, 16_777_217);
    } finally {
      closeSync(file);
    }
    await expect(owned.retire()).rejects.toBeInstanceOf(LocalTypecheckMetadataError);
    expect(lstatSync(owned.path).size).toBe(16_777_217);
    await expect(retireLocalTypecheckMetadata({ cwd: `${owned.cwd}/.` })).rejects.toBeInstanceOf(
      LocalTypecheckMetadataError,
    );
    expect(lstatSync(owned.path).size).toBe(16_777_217);
    expect(readdirSync(owned.cwd)).toEqual(["tsconfig.tsbuildinfo"]);
  });

  it("retains a replacement that races the retirement rename instead of deleting it", async (context) => {
    const owned = fixture(context);
    const native = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    writeFileSync(owned.path, generated, { mode: 0o600 });
    const original = join(owned.cwd, "original-metadata");
    let transferred = "";
    vi.mocked(rename).mockImplementationOnce(async (source, destination) => {
      expect(source).toBe(owned.path);
      await native.rename(source, original);
      writeFileSync(owned.path, "replacement bytes must remain", { mode: 0o600 });
      transferred = String(destination);
      await native.rename(source, destination);
    });
    try {
      await expect(owned.retire()).rejects.toBeInstanceOf(LocalTypecheckMetadataError);
      expect(readFileSync(original, "utf8")).toBe(generated);
      expect(readFileSync(transferred, "utf8")).toBe("replacement bytes must remain");
      expect(lstatSync(transferred).nlink).toBe(1);
    } finally {
      vi.mocked(rename).mockImplementation(native.rename);
    }
  });
});
