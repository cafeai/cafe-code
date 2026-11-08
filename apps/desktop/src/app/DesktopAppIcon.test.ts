import { MAX_DESKTOP_APP_ICON_PNG_BYTES } from "@cafecode/contracts";
// Native fixture boundary: exercise real private-file creation and permissions.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { fixturePng } from "../imageExport/__fixtures__/png.ts";
import { admitCustomIconPng, DesktopAppIconError, writePrivateIconFile } from "./DesktopAppIcon.ts";

const decodedImage = (width: number, height: number) => () => ({
  isEmpty: () => false,
  getSize: () => ({ width, height }),
});

describe("custom app icon admission", () => {
  it("accepts square PNGs from 256 to 1024 px", () => {
    for (const size of [256, 1024]) {
      const png = fixturePng({ width: size, height: size });
      expect(admitCustomIconPng(png, decodedImage(size, size))).toEqual(png);
    }
  });

  it("rejects non-square, undersized and oversized icons", () => {
    const cases = [
      [512, 256],
      [255, 255],
      [1025, 1025],
    ] as const;
    for (const [width, height] of cases) {
      expect(() =>
        admitCustomIconPng(fixturePng({ width, height }), decodedImage(width, height)),
      ).toThrow(DesktopAppIconError);
    }
  });

  it("rejects non-PNG bytes and payloads above the byte bound before decoding", () => {
    let decoded = false;
    const decode = () => {
      decoded = true;
      return decodedImage(512, 512)();
    };
    expect(() => admitCustomIconPng(new TextEncoder().encode("<svg/>"), decode)).toThrow(
      DesktopAppIconError,
    );
    expect(() =>
      admitCustomIconPng(new Uint8Array(MAX_DESKTOP_APP_ICON_PNG_BYTES + 1), decode),
    ).toThrow(DesktopAppIconError);
    expect(decoded).toBe(false);
  });

  it("rejects a decoder size that disagrees with the PNG header", () => {
    expect(() =>
      admitCustomIconPng(fixturePng({ width: 512, height: 512 }), decodedImage(256, 256)),
    ).toThrow(DesktopAppIconError);
  });
});

describe("private app icon storage", () => {
  it("replaces the stored icon atomically with an owner-only file and leaves no temporary", async () => {
    const root = await mkdtemp(join(tmpdir(), "cafe-app-icon-"));
    try {
      const directory = join(root, "app-icon");
      await writePrivateIconFile(directory, "custom.png", Buffer.from("first"));
      await writePrivateIconFile(directory, "custom.png", Buffer.from("second"));

      expect(await readFile(join(directory, "custom.png"), "utf8")).toBe("second");
      expect(await readdir(directory)).toEqual(["custom.png"]);
      if (process.platform !== "win32") {
        expect((await stat(join(directory, "custom.png"))).mode & 0o777).toBe(0o600);
        expect((await stat(directory)).mode & 0o777).toBe(0o700);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves other files in the icon folder untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "cafe-app-icon-"));
    try {
      const directory = join(root, "app-icon");
      await writePrivateIconFile(directory, "custom.png", Buffer.from("icon"));
      await writeFile(join(directory, "notes.txt"), "keep");
      await writePrivateIconFile(directory, "custom.png", Buffer.from("icon-2"));
      expect((await readdir(directory)).toSorted()).toEqual(["custom.png", "notes.txt"]);
      expect(await readFile(join(directory, "notes.txt"), "utf8")).toBe("keep");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
