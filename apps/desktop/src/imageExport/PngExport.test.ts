import { MAX_PNG_BYTES, MAX_PNG_DIMENSION, MAX_PNG_PIXELS } from "@cafecode/contracts";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    lstat: vi.fn(actual.lstat),
    rename: vi.fn(actual.rename),
  };
});

import { admitPng, decodePng, PngExportError, savePngFile } from "./PngExport.ts";
import { fixturePng, pngChunk } from "./__fixtures__/png.ts";

beforeEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(open).mockImplementation(actual.open);
  vi.mocked(lstat).mockImplementation(actual.lstat);
  vi.mocked(rename).mockImplementation(actual.rename);
});

async function withExportDirectory(task: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "cafe-png-export-"));
  try {
    await task(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const decodedImage = (width = 1, height = 1, empty = false) => ({
  isEmpty: () => empty,
  getSize: () => ({ width, height }),
});

describe("PNG export admission", () => {
  it("accepts the exact PNG emitted by the credential-free Chromium canvas fixture", () => {
    // Captured from an actual 8x6 browser canvas filled with rgb(29,139,84) and
    // encoded via canvas.toBlob("image/png") using the pinned Playwright runner.
    // This independent boundary sample has two contiguous IDAT chunks, unlike
    // the separately built Node fixture, and qualifies the browser's encoding
    // against native structural admission without touching an OS clipboard.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAYAAAD+Bd/7AAAAI0lEQVR4AczKMQ0AAAwCwQYfdVVXFQ0OYOWT3w77Rzcm1AAEAAD//+bREGYAAAAGSURBVAMAOL0P5RmD3FsAAAAASUVORK5CYII=",
      "base64",
    );
    const admitted = admitPng(png);
    expect(admitted.width).toBe(8);
    expect(admitted.height).toBe(6);
    expect(admitted.bytes).toEqual(png);
    expect(admitted.bytes.byteLength).toBe(110);
  });

  it("admits a complete static PNG with independently generated CRCs and owns its byte snapshot", () => {
    const png = fixturePng({ beforeData: [pngChunk("sRGB", Buffer.from([0]))] });
    const original = Buffer.from(png);
    const result = admitPng(png);
    png.fill(0);

    expect(result.width).toBe(1);
    expect(result.height).toBe(1);
    expect(result.bytes).toEqual(original);
    expect(result.bytes).not.toBe(png);
  });

  it.each([
    ["byte ceiling", () => new Uint8Array(MAX_PNG_BYTES + 1)],
    ["axis ceiling", () => fixturePng({ width: MAX_PNG_DIMENSION + 1 })],
    ["pixel ceiling", () => fixturePng({ width: MAX_PNG_DIMENSION, height: MAX_PNG_DIMENSION })],
    ["zero dimension", () => fixturePng({ width: 0 })],
    ["animation", () => fixturePng({ beforeData: [pngChunk("acTL", Buffer.alloc(8))] })],
    ["compressed metadata", () => fixturePng({ beforeData: [pngChunk("iCCP", Buffer.alloc(8))] })],
    ["trailing bytes", () => Buffer.concat([fixturePng(), Buffer.from("private trailing text")])],
    ["repeated header", () => fixturePng({ beforeData: [fixturePng().subarray(8, 33)] })],
    ["post-data metadata", () => fixturePng({ afterData: [pngChunk("sRGB", Buffer.from([0]))] })],
    ["truncated chunk", () => fixturePng().subarray(0, fixturePng().length - 1)],
    ["bad signature", () => Buffer.from("not a PNG image")],
    [
      "bad CRC",
      () => {
        const png = fixturePng();
        png[29] = png[29]! ^ 1;
        return png;
      },
    ],
  ])("refuses %s before calling the native pixel decoder", (_label, makePng) => {
    const decoder = vi.fn(() => decodedImage());
    expect(() => decodePng(makePng(), decoder)).toThrow(PngExportError);
    expect(decoder).not.toHaveBeenCalled();
  });

  it("enforces the pixel bound separately from either axis", () => {
    expect(MAX_PNG_PIXELS).toBe(16_777_216);
    expect(admitPng(fixturePng({ width: 4096, height: 4096 }))).toMatchObject({
      width: 4096,
      height: 4096,
    });
    expect(() => admitPng(fixturePng({ width: 4096, height: 4097 }))).toThrow(PngExportError);
  });

  it("refuses separated data chunks and excessive chunk counts", () => {
    expect(() =>
      admitPng(fixturePng({ afterData: [pngChunk("sRGB", Buffer.from([0])), pngChunk("IDAT")] })),
    ).toThrow(PngExportError);
    expect(() =>
      admitPng(fixturePng({ afterData: Array.from({ length: 4096 }, () => pngChunk("IDAT")) })),
    ).toThrow(PngExportError);
  });

  it("requires nonempty native pixels with the exact admitted dimensions and hides decoder exceptions", () => {
    const png = fixturePng();
    expect(() => decodePng(png, () => decodedImage(1, 1, true))).toThrow(PngExportError);
    expect(() => decodePng(png, () => decodedImage(2, 1))).toThrow(PngExportError);
    expect(() =>
      decodePng(png, () => {
        throw new Error("private native decoder detail");
      }),
    ).toThrow("The image could not be exported.");
    const image = decodedImage();
    expect(decodePng(png, () => image).image).toBe(image);
  });
});

describe("PNG save publication", () => {
  it("leaves files untouched for cancellation, owner closure and picker failure", async () => {
    await withExportDirectory(async (directory) => {
      const filePath = join(directory, "diagram.png");
      const bytes = fixturePng();
      const chooseDestination = vi.fn(async () => ({ canceled: false, filePath }));
      expect(await savePngFile({ bytes, chooseDestination, isCurrent: () => false })).toBe(
        "cancelled",
      );
      expect(chooseDestination).not.toHaveBeenCalled();
      expect(
        await savePngFile({
          bytes,
          chooseDestination: async () => ({ canceled: true, filePath }),
          isCurrent: () => true,
        }),
      ).toBe("cancelled");
      expect(
        await savePngFile({
          bytes,
          chooseDestination: async () => {
            throw new Error(`private picker path ${filePath}`);
          },
          isCurrent: () => true,
        }),
      ).toBe("failed");
      expect(await readdir(directory)).toEqual([]);
    });
  });

  it("privately publishes exact PNG bytes and atomically replaces a selected ordinary file", async () => {
    await withExportDirectory(async (directory) => {
      const filePath = join(directory, "diagram.png");
      const bytes = fixturePng();
      await writeFile(filePath, "old image remains complete until publication");
      expect(
        await savePngFile({
          bytes,
          chooseDestination: async () => ({ canceled: false, filePath }),
          isCurrent: () => true,
        }),
      ).toBe("saved");
      expect(await readFile(filePath)).toEqual(bytes);
      expect(await readdir(directory)).toEqual(["diagram.png"]);
      if (process.platform !== "win32") expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    });
  });

  it("drops its temporary image when the exact owner closes before publication", async () => {
    await withExportDirectory(async (directory) => {
      const filePath = join(directory, "diagram.png");
      await writeFile(filePath, "unchanged original");
      let checks = 0;
      expect(
        await savePngFile({
          bytes: fixturePng(),
          chooseDestination: async () => ({ canceled: false, filePath }),
          isCurrent: () => ++checks < 3,
        }),
      ).toBe("cancelled");
      expect(await readFile(filePath, "utf8")).toBe("unchanged original");
      expect(await readdir(directory)).toEqual(["diagram.png"]);
    });
  });

  it("cancels when ownership is revoked during the final namespace observation without dispatching rename", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    await withExportDirectory(async (root) => {
      const directory = await realpath(root);
      const filePath = join(directory, "diagram.png");
      const bytes = fixturePng();
      await writeFile(filePath, "unchanged original");
      let candidate: string | undefined;
      let current = true;
      let destinationObservations = 0;
      let revokedDuringFinalObservation = false;
      let candidateSizeAtRevocation: bigint | number | undefined;
      vi.mocked(rename).mockClear();
      vi.mocked(open).mockImplementation(async (path, flags, mode) => {
        const handle = await actual.open(path, flags, mode);
        if (
          typeof path === "string" &&
          dirname(path) === directory &&
          basename(path).endsWith(".tmp")
        )
          candidate = path;
        return handle;
      });
      vi.mocked(lstat).mockImplementation(async (path, options) => {
        const observed = await actual.lstat(path, options);
        if (path === filePath) destinationObservations += 1;
        // The second destination observation precedes the final parent/temp
        // checks. Revoke inside that last awaited tempfile observation, after
        // pixels are flushed but before the publication operation can begin.
        if (
          candidate &&
          path === candidate &&
          destinationObservations === 2 &&
          !revokedDuringFinalObservation
        ) {
          candidateSizeAtRevocation = observed.size;
          revokedDuringFinalObservation = true;
          current = false;
        }
        return observed;
      });
      expect(
        await savePngFile({
          bytes,
          chooseDestination: async () => ({ canceled: false, filePath }),
          isCurrent: () => current,
        }),
      ).toBe("cancelled");
      expect(revokedDuringFinalObservation).toBe(true);
      expect(candidateSizeAtRevocation).toBe(BigInt(bytes.byteLength));
      expect(rename).not.toHaveBeenCalled();
      expect(await readFile(filePath, "utf8")).toBe("unchanged original");
      expect(await readdir(directory)).toEqual(["diagram.png"]);
      expect(candidate).toBeDefined();
      await expect(lstat(candidate!)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("refuses a selected symlink without modifying its target", async (context) => {
    await withExportDirectory(async (directory) => {
      const target = join(directory, "original.png");
      const filePath = join(directory, "diagram.png");
      await writeFile(target, "unchanged target");
      try {
        await symlink(target, filePath);
      } catch (error) {
        if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
          context.skip("Windows host does not grant this fixture symlink creation privileges.");
          return;
        }
        throw error;
      }
      expect(
        await savePngFile({
          bytes: fixturePng(),
          chooseDestination: async () => ({ canceled: false, filePath }),
          isCurrent: () => true,
        }),
      ).toBe("failed");
      expect(await readFile(target, "utf8")).toBe("unchanged target");
      expect((await readdir(directory)).toSorted()).toEqual(["diagram.png", "original.png"]);
    });
  });

  it("rejects non-file, relative and control-character native destinations", async () => {
    await withExportDirectory(async (directory) => {
      for (const filePath of [directory, "relative.png", join(directory, "bad\u0000.png")]) {
        expect(
          await savePngFile({
            bytes: fixturePng(),
            chooseDestination: async () => ({ canceled: false, filePath }),
            isCurrent: () => true,
          }),
        ).toBe("failed");
      }
      expect(await readdir(directory)).toEqual([]);
    });
  });

  it("refuses a selected parent replacement before writing any pixels through the newly opened file", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    await withExportDirectory(async (root) => {
      const directory = join(await realpath(root), "selected");
      const displaced = join(await realpath(root), "displaced");
      await mkdir(directory);
      const filePath = join(directory, "diagram.png");
      await writeFile(filePath, "unchanged original");
      let candidate: string | undefined;
      vi.mocked(open).mockImplementation(async (path, flags, mode) => {
        if (
          typeof path === "string" &&
          dirname(path) === directory &&
          basename(path).endsWith(".tmp")
        ) {
          candidate = path;
          await rename(directory, displaced);
          await mkdir(directory);
          await writeFile(join(directory, "unrelated.txt"), "must remain untouched");
        }
        return await actual.open(path, flags, mode);
      });
      expect(
        await savePngFile({
          bytes: fixturePng(),
          chooseDestination: async () => ({ canceled: false, filePath }),
          isCurrent: () => true,
        }),
      ).toBe("failed");
      expect(candidate).toBeDefined();
      expect(await readFile(candidate!)).toEqual(Buffer.alloc(0));
      expect(await readFile(join(displaced, "diagram.png"), "utf8")).toBe("unchanged original");
      expect(await readFile(join(directory, "unrelated.txt"), "utf8")).toBe(
        "must remain untouched",
      );
      await expect(readFile(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("refuses a post-open directory identity mismatch before writing on every host", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    await withExportDirectory(async (root) => {
      const directory = join(await realpath(root), "selected");
      await mkdir(directory);
      const filePath = join(directory, "diagram.png");
      await writeFile(filePath, "unchanged original");
      let candidate: string | undefined;
      vi.mocked(open).mockImplementation(async (path, flags, mode) => {
        const handle = await actual.open(path, flags, mode);
        if (
          typeof path === "string" &&
          dirname(path) === directory &&
          basename(path).endsWith(".tmp")
        )
          candidate = path;
        return handle;
      });
      vi.mocked(lstat).mockImplementation(async (path, options) => {
        const observed = await actual.lstat(path, options);
        if (path === directory && candidate)
          return Object.assign(observed, {
            ino: typeof observed.ino === "bigint" ? observed.ino + 1n : observed.ino + 1,
          });
        return observed;
      });
      expect(
        await savePngFile({
          bytes: fixturePng(),
          chooseDestination: async () => ({ canceled: false, filePath }),
          isCurrent: () => true,
        }),
      ).toBe("failed");
      expect(candidate).toBeDefined();
      expect(await readFile(candidate!)).toEqual(Buffer.alloc(0));
      expect(await readFile(filePath, "utf8")).toBe("unchanged original");
    });
  });

  it("refuses a replacement tempfile inode and preserves that unowned sibling during cleanup", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    await withExportDirectory(async (root) => {
      const directory = join(await realpath(root), "selected");
      await mkdir(directory);
      const filePath = join(directory, "diagram.png");
      await writeFile(filePath, "unchanged original");
      let candidate: string | undefined;
      let injected = false;
      vi.mocked(open).mockImplementation(async (path, flags, mode) => {
        const handle = await actual.open(path, flags, mode);
        if (
          typeof path === "string" &&
          dirname(path) === directory &&
          basename(path).endsWith(".tmp")
        )
          candidate = path;
        return handle;
      });
      vi.mocked(lstat).mockImplementation(async (path, options) => {
        const observed = await actual.lstat(path, options);
        // This exact metadata substitution is portable even when Windows denies
        // physically moving an opened candidate. Other file metadata is real.
        if (path === candidate) {
          injected = true;
          return Object.assign(observed, {
            ino: typeof observed.ino === "bigint" ? observed.ino + 1n : observed.ino + 1,
          });
        }
        return observed;
      });
      expect(
        await savePngFile({
          bytes: fixturePng(),
          chooseDestination: async () => ({ canceled: false, filePath }),
          isCurrent: () => true,
        }),
      ).toBe("failed");
      expect(injected).toBe(true);
      expect(candidate).toBeDefined();
      expect(await readFile(candidate!)).toEqual(Buffer.alloc(0));
      expect(await readFile(filePath, "utf8")).toBe("unchanged original");
    });
  });

  it("rejects a tempfile replaced after its held write without publishing or deleting the replacement", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    await withExportDirectory(async (root) => {
      const directory = join(await realpath(root), "selected");
      await mkdir(directory);
      const filePath = join(directory, "diagram.png");
      const displaced = join(directory, "displaced-temp");
      await writeFile(filePath, "unchanged original");
      let candidate: string | undefined;
      let windowsRenameRefused = false;
      vi.mocked(open).mockImplementation(async (path, flags, mode) => {
        const handle = await actual.open(path, flags, mode);
        if (
          typeof path === "string" &&
          dirname(path) === directory &&
          basename(path).endsWith(".tmp")
        ) {
          candidate = path;
          const sync = handle.sync.bind(handle);
          vi.spyOn(handle, "sync").mockImplementation(async () => {
            await sync();
            try {
              await rename(path, displaced);
            } catch (error) {
              if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM")
                windowsRenameRefused = true;
              throw error;
            }
            await writeFile(path, "unowned replacement must remain");
          });
        }
        return handle;
      });
      expect(
        await savePngFile({
          bytes: fixturePng(),
          chooseDestination: async () => ({ canceled: false, filePath }),
          isCurrent: () => true,
        }),
      ).toBe("failed");
      expect(candidate).toBeDefined();
      expect(await readFile(filePath, "utf8")).toBe("unchanged original");
      if (!windowsRenameRefused) {
        expect(await readFile(displaced)).toEqual(fixturePng());
        expect(await readFile(candidate!, "utf8")).toBe("unowned replacement must remain");
      } else {
        await expect(lstat(displaced)).rejects.toMatchObject({ code: "ENOENT" });
      }
    });
  });
});
