import type { SidebarBrandImageMimeType } from "@cafecode/contracts";

export interface ParsedImageHeader {
  readonly mimeType: SidebarBrandImageMimeType;
  readonly width: number;
  readonly height: number;
}

function readUint16BigEndian(bytes: Uint8Array, offset: number): number | null {
  if (offset + 2 > bytes.byteLength) return null;
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function readUint16LittleEndian(bytes: Uint8Array, offset: number): number | null {
  if (offset + 2 > bytes.byteLength) return null;
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readUint24LittleEndian(bytes: Uint8Array, offset: number): number | null {
  if (offset + 3 > bytes.byteLength) return null;
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function readUint32BigEndian(bytes: Uint8Array, offset: number): number | null {
  if (offset + 4 > bytes.byteLength) return null;
  return (
    bytes[offset]! * 0x1000000 +
    ((bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!)
  );
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string | null {
  if (offset + length > bytes.byteLength) return null;
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function parsePngHeader(bytes: Uint8Array): ParsedImageHeader | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
  if (bytes.byteLength < 24 || !signature.every((value, index) => bytes[index] === value)) {
    return null;
  }
  if (readAscii(bytes, 12, 4) !== "IHDR") return null;
  const width = readUint32BigEndian(bytes, 16);
  const height = readUint32BigEndian(bytes, 20);
  if (!width || !height) return null;
  return { mimeType: "image/png", width, height };
}

function parseGifHeader(bytes: Uint8Array): ParsedImageHeader | null {
  const signature = readAscii(bytes, 0, 6);
  if (signature !== "GIF87a" && signature !== "GIF89a") return null;
  const width = readUint16LittleEndian(bytes, 6);
  const height = readUint16LittleEndian(bytes, 8);
  if (!width || !height) return null;
  return { mimeType: "image/gif", width, height };
}

function isJpegStartOfFrame(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function parseJpegHeader(bytes: Uint8Array): ParsedImageHeader | null {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let offset = 2;
  while (offset + 4 <= bytes.byteLength) {
    while (offset < bytes.byteLength && bytes[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= bytes.byteLength) return null;
    const marker = bytes[offset]!;
    offset += 1;

    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker >= 0xd0 && marker <= 0xd7) continue;

    const segmentLength = readUint16BigEndian(bytes, offset);
    if (!segmentLength || segmentLength < 2 || offset + segmentLength > bytes.byteLength) {
      return null;
    }

    if (isJpegStartOfFrame(marker)) {
      if (segmentLength < 7) return null;
      const height = readUint16BigEndian(bytes, offset + 3);
      const width = readUint16BigEndian(bytes, offset + 5);
      if (!width || !height) return null;
      return { mimeType: "image/jpeg", width, height };
    }

    offset += segmentLength;
  }

  return null;
}

function parseWebpHeader(bytes: Uint8Array): ParsedImageHeader | null {
  if (
    bytes.byteLength < 30 ||
    readAscii(bytes, 0, 4) !== "RIFF" ||
    readAscii(bytes, 8, 4) !== "WEBP"
  ) {
    return null;
  }

  const chunkType = readAscii(bytes, 12, 4);
  if (chunkType === "VP8X") {
    const widthMinusOne = readUint24LittleEndian(bytes, 24);
    const heightMinusOne = readUint24LittleEndian(bytes, 27);
    if (widthMinusOne === null || heightMinusOne === null) return null;
    return {
      mimeType: "image/webp",
      width: widthMinusOne + 1,
      height: heightMinusOne + 1,
    };
  }

  if (chunkType === "VP8L") {
    if (bytes.byteLength < 25 || bytes[20] !== 0x2f) return null;
    const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
    return {
      mimeType: "image/webp",
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }

  if (chunkType === "VP8 ") {
    if (bytes.byteLength < 30) return null;
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    const width = readUint16LittleEndian(bytes, 26);
    const height = readUint16LittleEndian(bytes, 28);
    if (!width || !height) return null;
    return { mimeType: "image/webp", width: width & 0x3fff, height: height & 0x3fff };
  }

  return null;
}

export function parseImageHeader(bytes: Uint8Array): ParsedImageHeader | null {
  return (
    parsePngHeader(bytes) ??
    parseGifHeader(bytes) ??
    parseJpegHeader(bytes) ??
    parseWebpHeader(bytes)
  );
}
