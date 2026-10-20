// Native checkout/fixture IO retains its existing descriptor, identity and lifetime semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { access, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
// Host-native path spelling must agree with the existing native file and tool boundary.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertBrowserArtifactDirectory,
  selectBrowserBridgeConfigurations,
  withBrowserArtifactDirectory,
  type BrowserBridgeConfiguration,
} from "./browser-test-artifacts.ts";

vi.mock("node:fs/promises", async (original) => {
  const native = await original<typeof import("node:fs/promises")>();
  return { ...native, rename: vi.fn(native.rename) };
});

const entries = {
  "mcp-bridge": "src/mcp/localBridgeEntry.ts",
  "scheduling-mcp-bridge": "src/mcp/schedulingBridgeEntry.ts",
  "visualization-mcp-bridge": "src/mcp/visualizationBridgeEntry.ts",
};

describe("isolated browser bridge preparation", () => {
  it("retains the exact shipping configuration rather than substituting a test bundling policy", () => {
    const alwaysBundle = () => true;
    const shipping = Object.entries(entries).map(([name, entry]): BrowserBridgeConfiguration => ({
      entry: { [name]: entry },
      deps: { alwaysBundle },
      outputOptions: { codeSplitting: false },
    }));
    const unrelated: BrowserBridgeConfiguration = { entry: { other: "src/other.ts" } };
    const selected = selectBrowserBridgeConfigurations([unrelated, ...shipping]);
    for (let index = 0; index < shipping.length; index++) {
      expect(selected[index]).toBe(shipping[index]);
      expect(selected[index]!.deps?.alwaysBundle).toBe(alwaysBundle);
      expect(selected[index]!.outputOptions).toEqual({ codeSplitting: false });
    }
    expect(() => selectBrowserBridgeConfigurations(shipping.slice(1))).toThrow("missing");
    expect(() => selectBrowserBridgeConfigurations([...shipping, shipping[0]!])).toThrow(
      "ambiguous",
    );
    expect(() =>
      selectBrowserBridgeConfigurations([
        { entry: { "mcp-bridge": "src/not-the-shipping-entry.ts" } },
        ...shipping.slice(1),
      ]),
    ).toThrow("missing");
  });

  it("keeps fixture output private and removes only its exact owned directory after completion", async () => {
    let retired = "";
    const value = await withBrowserArtifactDirectory(async (directory) => {
      retired = directory.path;
      await assertBrowserArtifactDirectory(directory);
      const stat = await lstat(directory.path);
      if (process.platform !== "win32") expect(stat.mode & 0o077).toBe(0);
      await writeFile(join(directory.path, "owned-fixture"), "inert");
      return "completed";
    });
    expect(value).toBe("completed");
    await expect(access(retired)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains partial artifacts after failure rather than assuming descendant retirement", async () => {
    let retired = "";
    try {
      await expect(
        withBrowserArtifactDirectory(async (directory) => {
          retired = directory.path;
          await writeFile(join(directory.path, "partial-fixture"), "inert");
          throw new Error("synthetic preparation failure");
        }),
      ).rejects.toThrow("synthetic preparation failure");
      expect(await readFile(join(retired, "partial-fixture"), "utf8")).toBe("inert");
    } finally {
      if (retired) await rm(retired, { recursive: true, force: true });
    }
  });

  it("retains a replacement namespace rather than deleting another directory during cleanup", async () => {
    let original = "";
    let moved = "";
    try {
      await expect(
        withBrowserArtifactDirectory(async (directory) => {
          original = directory.path;
          moved = `${original}.moved`;
          await rename(original, moved);
          await mkdir(original, { mode: 0o700 });
          await writeFile(join(original, "replacement"), "must remain");
        }),
      ).rejects.toThrow("exact private owner");
      expect(await readFile(join(original, "replacement"), "utf8")).toBe("must remain");
      expect((await lstat(moved)).isDirectory()).toBe(true);
    } finally {
      if (original) await rm(original, { recursive: true, force: true });
      if (moved) await rm(moved, { recursive: true, force: true });
    }
  });

  it("checks the transferred inode when a source replacement races its retirement rename", async () => {
    const native = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let original = "";
    let moved = "";
    let transferred = "";
    try {
      vi.mocked(rename).mockImplementationOnce(async (source, destination) => {
        expect(source).toBe(original);
        moved = `${original}.moved`;
        await native.rename(source, moved);
        await mkdir(original, { mode: 0o700 });
        await writeFile(join(original, "replacement"), "must remain after transfer");
        transferred = String(destination);
        await native.rename(source, destination);
      });
      await expect(
        withBrowserArtifactDirectory(async (directory) => {
          original = directory.path;
          await writeFile(join(original, "owned"), "original fixture");
        }),
      ).rejects.toThrow("exact private owner");
      expect(await readFile(join(transferred, "replacement"), "utf8")).toBe(
        "must remain after transfer",
      );
      expect(await readFile(join(moved, "owned"), "utf8")).toBe("original fixture");
    } finally {
      vi.mocked(rename).mockImplementation(native.rename);
      if (moved) await rm(moved, { recursive: true, force: true });
      if (transferred) await rm(dirname(transferred), { recursive: true, force: true });
    }
  });
});
