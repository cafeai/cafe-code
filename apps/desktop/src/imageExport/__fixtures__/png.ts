import { crc32, deflateSync } from "node:zlib";

/** Use Node's independent CRC implementation to build credential-free PNGs. */
export function pngChunk(type: string, contents: Buffer = Buffer.alloc(0)): Buffer {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(contents.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, contents])));
  return Buffer.concat([length, name, contents, checksum]);
}

/** The pixels are always a real 1px PNG; altered dimensions exercise admission. */
export function fixturePng(input?: {
  readonly width?: number;
  readonly height?: number;
  readonly beforeData?: readonly Buffer[];
  readonly afterData?: readonly Buffer[];
}): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(input?.width ?? 1);
  header.writeUInt32BE(input?.height ?? 1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    ...(input?.beforeData ?? []),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 130, 40, 90, 255]))),
    ...(input?.afterData ?? []),
    pngChunk("IEND"),
  ]);
}
