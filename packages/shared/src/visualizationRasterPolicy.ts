import {
  VISUALIZATION_HOST_MAX_ASSET_BYTES,
  type VisualizationHostDocument,
} from "@cafecode/contracts/visualizationHost";

/** The same finite header admission precedes any browser or legacy native image
 * decoder. It proves dimensions, not successful decompression or metadata
 * stripping; direct browser documents receive the exactly committed original.
 * No file path, network fetch, profile or allocation-sized decode occurs here. */
export function rasterDimensions(
  bytes: Buffer,
  mime: VisualizationHostDocument["assets"][number]["mime"],
): { width: number; height: number } | null {
  if (bytes.length === 0 || bytes.length > VISUALIZATION_HOST_MAX_ASSET_BYTES) return null;
  let width = 0;
  let height = 0;
  if (mime === "image/png") {
    if (
      bytes.length < 33 ||
      bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
      bytes.readUInt32BE(8) !== 13 ||
      bytes.toString("ascii", 12, 16) !== "IHDR"
    )
      return null;
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else if (mime === "image/jpeg") {
    if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) return null;
    let offset = 2;
    // The encoded-byte cap bounds this nonallocating metadata scan. Entropy
    // data before a supported SOF is not evidence of dimensions.
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1]!;
      if (marker === 0xff) {
        offset += 1;
        continue;
      }
      if (marker === 0xda || marker === 0xd9 || marker === 0x00) return null;
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) return null;
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        if (length < 8) return null;
        height = bytes.readUInt16BE(offset + 5);
        width = bytes.readUInt16BE(offset + 7);
        break;
      }
      offset += length + 2;
    }
  } else if (mime === "image/webp") {
    if (
      bytes.length < 30 ||
      bytes.toString("ascii", 0, 4) !== "RIFF" ||
      bytes.toString("ascii", 8, 12) !== "WEBP"
    )
      return null;
    const kind = bytes.toString("ascii", 12, 16);
    if (kind === "VP8X") {
      if (bytes.readUInt32LE(16) !== 10 || (bytes[20]! & 2) !== 0) return null;
      width = bytes.readUIntLE(24, 3) + 1;
      height = bytes.readUIntLE(27, 3) + 1;
    } else if (kind === "VP8 " && bytes.toString("hex", 23, 26) === "9d012a") {
      width = bytes.readUInt16LE(26) & 0x3fff;
      height = bytes.readUInt16LE(28) & 0x3fff;
    } else if (kind === "VP8L" && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
    } else return null;
  } else return null;
  return width > 0 && height > 0 && width <= 4096 && height <= 4096 && width * height <= 8_000_000
    ? { width, height }
    : null;
}
