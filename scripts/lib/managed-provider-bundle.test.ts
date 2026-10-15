// @effect-diagnostics nodeBuiltinImport:off
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { realpath, mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractVerifiedProviderArchive,
  managedCodexExecutable,
  prepareManagedBundle,
  inventoryManagedBundle,
} from "./managed-provider-bundle.ts";

function tar(name: string, content = "fixture", type = "0") {
  const header = Buffer.alloc(512);
  header.write(name, 0);
  header.write("0000644\0", 100);
  header.write(content.length.toString(8).padStart(11, "0") + "\0", 124);
  header.write(type, 156);
  header.fill(32, 148, 156);
  const checksum = header.reduce((sum, value) => sum + value, 0);
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
  return gzipSync(
    Buffer.concat([
      header,
      Buffer.from(content),
      Buffer.alloc((512 - (content.length % 512)) % 512),
      Buffer.alloc(1024),
    ]),
  );
}
const integrity = (bytes: Buffer) =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
async function fixture(
  task: (input: {
    root: string;
    source: string;
    managedRoot: string;
    settingsPath: string;
  }) => Promise<void>,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cafe-managed-transaction-")));
  try {
    const source = join(root, "bundle");
    const content = join(source, "content");
    await mkdir(content, { recursive: true });
    await writeFile(join(content, "runtime.txt"), "qualified bytes");
    await writeFile(
      join(source, "inventory.json"),
      JSON.stringify(await inventoryManagedBundle(content)),
    );
    await task({
      root,
      source,
      managedRoot: join(root, "managed"),
      settingsPath: join(root, "profile", "settings.json"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("verified managed provider generations", () => {
  it("probes the reviewed native bin layout on both Windows architectures", () => {
    const root = join(tmpdir(), "owned-generation");
    expect(managedCodexExecutable(root, "x64")).toBe(
      join(
        root,
        "providers",
        "codex",
        "node_modules",
        "@openai",
        "codex-win32-x64",
        "vendor",
        "x86_64-pc-windows-msvc",
        "bin",
        "codex.exe",
      ),
    );
    expect(managedCodexExecutable(root, "arm64")).toBe(
      join(
        root,
        "providers",
        "codex",
        "node_modules",
        "@openai",
        "codex-win32-arm64",
        "vendor",
        "aarch64-pc-windows-msvc",
        "bin",
        "codex.exe",
      ),
    );
  });

  it("rejects modified archives, traversal, Windows device names and linked entries before publication", async () => {
    await fixture(async ({ root }) => {
      const valid = tar("package/bin/cli.js");
      const target = join(root, "valid");
      await extractVerifiedProviderArchive(valid, integrity(valid), target);
      expect(await readFile(join(target, "bin/cli.js"), "utf8")).toBe("fixture");
      await expect(
        extractVerifiedProviderArchive(valid, integrity(tar("package/other")), join(root, "bad")),
      ).rejects.toThrow("integrity");
      for (const [name, type] of [
        ["package/../escape", "0"],
        ["package/C:/escape", "0"],
        ["package/CON.txt", "0"],
        ["package/link", "2"],
      ]) {
        const bytes = tar(name!, "fixture", type);
        await expect(
          extractVerifiedProviderArchive(bytes, integrity(bytes), join(root, "unsafe")),
        ).rejects.toThrow("Unsafe");
      }
      expect(await readdir(root)).not.toContain("escape");
    });
  });
  it("prepares verified exclusive generations without changing activation or settings", async () => {
    await fixture(async (input) => {
      await mkdir(input.managedRoot);
      await mkdir(join(input.root, "profile"));
      await writeFile(input.settingsPath, "existing user settings");
      const active = join(input.managedRoot, "active-runtime.json");
      await writeFile(active, "previous activation");
      const first = await prepareManagedBundle(input);
      expect(await readFile(active, "utf8")).toBe("previous activation");
      expect(await readFile(input.settingsPath, "utf8")).toBe("existing user settings");
      expect(
        await readFile(join(input.managedRoot, "generations", first, "runtime.txt"), "utf8"),
      ).toBe("qualified bytes");
      await expect(
        prepareManagedBundle({
          ...input,
          probe: async () => {
            throw new Error("launch failed");
          },
        }),
      ).rejects.toThrow("launch failed");
      expect(await readFile(active, "utf8")).toBe("previous activation");
      await writeFile(join(input.source, "content/runtime.txt"), "tampered");
      await expect(prepareManagedBundle(input)).rejects.toThrow("verification");
      expect(await readFile(active, "utf8")).toBe("previous activation");
    });
  });
});
