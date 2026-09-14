import { inflateSync } from "node:zlib";
import * as fs from "node:fs/promises";

/** Decode only the RGB8 PNGs produced by the native fixture's libpng encoder.
 * Checking actual presented pixels catches blank/swizzled GPU imports that a
 * transport handshake or successful input alone would miss. */
export function fixturePixel(png: string, x: number, y: number): readonly number[] {
  return [...fixtureRegion(png, x, y, 1, 1)];
}

/** Read a small region in one decode, e.g. to detect a composited host cursor. */
export function fixtureRegion(
  png: string,
  x: number,
  y: number,
  regionWidth: number,
  regionHeight: number,
): Buffer {
  const bytes = Buffer.from(png, "base64"),
    compressed: Buffer[] = [];
  let width = 0,
    height = 0;
  for (let at = 8; at + 12 <= bytes.length; ) {
    const size = bytes.readUInt32BE(at),
      type = bytes.toString("ascii", at + 4, at + 8);
    if (type === "IHDR") {
      width = bytes.readUInt32BE(at + 8);
      height = bytes.readUInt32BE(at + 12);
      if (bytes[at + 16] !== 8 || bytes[at + 17] !== 2) throw new Error("Fixture PNG is not RGB8.");
    }
    if (type === "IDAT") compressed.push(bytes.subarray(at + 8, at + 8 + size));
    at += size + 12;
  }
  if (
    width < 1 ||
    height < 1 ||
    width > 2048 ||
    height > 2048 ||
    x < 0 ||
    y < 0 ||
    regionWidth < 1 ||
    regionHeight < 1 ||
    x + regionWidth > width ||
    y + regionHeight > height
  )
    throw new Error("Invalid fixture pixel.");
  const raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: (width * 3 + 1) * height });
  const row = Buffer.alloc(width * 3),
    previous = Buffer.alloc(width * 3);
  const region = Buffer.alloc(regionWidth * regionHeight * 3);
  for (let line = 0; line < y + regionHeight; line++) {
    const filter = raw[line * (width * 3 + 1)]!;
    for (let i = 0; i < row.length; i++) {
      const a = i >= 3 ? row[i - 3]! : 0,
        b = previous[i]!,
        c = i >= 3 ? previous[i - 3]! : 0;
      const p = a + b - c,
        pa = Math.abs(p - a),
        pb = Math.abs(p - b),
        pc = Math.abs(p - c);
      const prediction =
        filter === 0
          ? 0
          : filter === 1
            ? a
            : filter === 2
              ? b
              : filter === 3
                ? Math.floor((a + b) / 2)
                : filter === 4
                  ? pa <= pb && pa <= pc
                    ? a
                    : pb <= pc
                      ? b
                      : c
                  : NaN;
      if (!Number.isFinite(prediction)) throw new Error("Invalid fixture PNG filter.");
      row[i] = (raw[line * (width * 3 + 1) + i + 1]! + prediction) & 255;
    }
    row.copy(previous);
    if (line >= y) row.copy(region, (line - y) * regionWidth * 3, x * 3, (x + regionWidth) * 3);
  }
  return region;
}

export async function nativeResources(pid: number) {
  const status = await fs.readFile(`/proc/${pid}/status`, "utf8");
  return {
    rssKiB: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0),
    descriptors: (await fs.readdir(`/proc/${pid}/fd`)).length,
  };
}
