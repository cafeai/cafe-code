import { createHash } from "node:crypto";

import {
  MAX_SIDEBAR_BRAND_IMAGE_DIMENSION,
  MAX_SIDEBAR_BRAND_IMAGE_FILE_BYTES,
  MAX_SIDEBAR_BRAND_IMAGE_PIXEL_COUNT,
  type SidebarBrandImageAsset,
  type SidebarBrandImageMimeType,
} from "@cafecode/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Random from "effect/Random";

import { parseBase64DataUrl } from "../imageMime.ts";
import { ServerConfig } from "../config.ts";

const BRANDING_IMAGE_ROUTE_PREFIX = "/api/branding/sidebar-image/";
const SIDEBAR_BRANDING_SUBDIR = "branding/sidebar";
const SIDEBAR_BRANDING_ID_PATTERN = /^sha256-[a-f0-9]{64}\.(?:gif|jpe?g|png|webp)$/;

const MIME_TYPE_BY_EXTENSION = {
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
} as const satisfies Record<string, SidebarBrandImageMimeType>;

const EXTENSION_BY_MIME_TYPE = {
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
} as const satisfies Record<SidebarBrandImageMimeType, string>;

export type BrandingImageErrorCode =
  | "invalid-data-url"
  | "invalid-id"
  | "invalid-image"
  | "not-found"
  | "storage-failed"
  | "too-large"
  | "unsupported-type";

export class BrandingImageError extends Data.TaggedError("BrandingImageError")<{
  readonly code: BrandingImageErrorCode;
  readonly message: string;
  readonly status: 400 | 404 | 413 | 415 | 500;
  readonly cause?: unknown;
}> {}

export interface StoredBrandingImage {
  readonly id: string;
  readonly filePath: string;
  readonly mimeType: SidebarBrandImageMimeType;
}

export interface BrandingImageStoreShape {
  readonly storeUploadedImage: (input: {
    readonly bytes: Uint8Array;
    readonly declaredMimeType?: string | undefined;
  }) => Effect.Effect<SidebarBrandImageAsset, BrandingImageError>;
  readonly storeLegacyDataUrl: (
    dataUrl: string,
  ) => Effect.Effect<SidebarBrandImageAsset, BrandingImageError>;
  readonly resolveStoredImage: (
    id: string,
  ) => Effect.Effect<StoredBrandingImage, BrandingImageError>;
}

export class BrandingImageStore extends Context.Service<
  BrandingImageStore,
  BrandingImageStoreShape
>()("cafecode/branding/BrandingImageStore") {}

/**
 * User-selected branding image bytes are private user content. Keep the bytes
 * outside ClientSettings so server config snapshots and WebSocket settings
 * updates only carry compact metadata, never base64 payloads.
 */
interface ParsedImageHeader {
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

function parseImageHeader(bytes: Uint8Array): ParsedImageHeader | null {
  return (
    parsePngHeader(bytes) ??
    parseGifHeader(bytes) ??
    parseJpegHeader(bytes) ??
    parseWebpHeader(bytes)
  );
}

function normalizeDeclaredMimeType(value: string | undefined): SidebarBrandImageMimeType | null {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase();
  if (normalized === "image/jpg") return "image/jpeg";
  if (
    normalized === "image/gif" ||
    normalized === "image/jpeg" ||
    normalized === "image/png" ||
    normalized === "image/webp"
  ) {
    return normalized;
  }
  return null;
}

function validateImageBytes(input: {
  readonly bytes: Uint8Array;
  readonly declaredMimeType?: string | undefined;
}): Effect.Effect<ParsedImageHeader, BrandingImageError> {
  return Effect.gen(function* () {
    if (input.bytes.byteLength === 0) {
      return yield* new BrandingImageError({
        code: "invalid-image",
        status: 400,
        message: "Sidebar image is empty.",
      });
    }

    if (input.bytes.byteLength > MAX_SIDEBAR_BRAND_IMAGE_FILE_BYTES) {
      return yield* new BrandingImageError({
        code: "too-large",
        status: 413,
        message: "Sidebar image is too large.",
      });
    }

    const declaredMimeType = normalizeDeclaredMimeType(input.declaredMimeType);
    if (input.declaredMimeType && !declaredMimeType) {
      return yield* new BrandingImageError({
        code: "unsupported-type",
        status: 415,
        message: "Sidebar image type is unsupported.",
      });
    }

    const header = parseImageHeader(input.bytes);
    if (!header) {
      return yield* new BrandingImageError({
        code: "invalid-image",
        status: 400,
        message: "Sidebar image data is invalid.",
      });
    }

    if (declaredMimeType && declaredMimeType !== header.mimeType) {
      return yield* new BrandingImageError({
        code: "unsupported-type",
        status: 415,
        message: "Sidebar image type does not match the file data.",
      });
    }

    if (header.width < 1 || header.height < 1) {
      return yield* new BrandingImageError({
        code: "invalid-image",
        status: 400,
        message: "Sidebar image dimensions are invalid.",
      });
    }

    if (
      header.width > MAX_SIDEBAR_BRAND_IMAGE_DIMENSION ||
      header.height > MAX_SIDEBAR_BRAND_IMAGE_DIMENSION ||
      header.width * header.height > MAX_SIDEBAR_BRAND_IMAGE_PIXEL_COUNT
    ) {
      return yield* new BrandingImageError({
        code: "too-large",
        status: 413,
        message: "Sidebar image dimensions are too large.",
      });
    }

    return header;
  });
}

function extensionForId(id: string): string | null {
  const match = /(\.[a-z0-9]+)$/.exec(id);
  return match?.[1]?.toLowerCase() ?? null;
}

function mimeTypeForId(id: string): SidebarBrandImageMimeType | null {
  const extension = extensionForId(id);
  return extension && Object.hasOwn(MIME_TYPE_BY_EXTENSION, extension)
    ? MIME_TYPE_BY_EXTENSION[extension as keyof typeof MIME_TYPE_BY_EXTENSION]
    : null;
}

function sidebarBrandImageUrl(id: string): string {
  return `${BRANDING_IMAGE_ROUTE_PREFIX}${id}`;
}

function assetFromStoredBytes(input: {
  readonly id: string;
  readonly bytes: Uint8Array;
  readonly header: ParsedImageHeader;
}): SidebarBrandImageAsset {
  return {
    id: input.id,
    url: sidebarBrandImageUrl(input.id),
    mimeType: input.header.mimeType,
    width: input.header.width,
    height: input.header.height,
    sizeBytes: input.bytes.byteLength,
  };
}

function makeImageId(bytes: Uint8Array, mimeType: SidebarBrandImageMimeType): string {
  const hash = createHash("sha256").update(bytes).digest("hex");
  return `sha256-${hash}${EXTENSION_BY_MIME_TYPE[mimeType]}`;
}

function assertValidImageId(id: string): Effect.Effect<void, BrandingImageError> {
  return SIDEBAR_BRANDING_ID_PATTERN.test(id)
    ? Effect.void
    : Effect.fail(
        new BrandingImageError({
          code: "invalid-id",
          status: 404,
          message: "Sidebar image was not found.",
        }),
      );
}

function makeBrandingImageStore() {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const imageDir = path.join(config.stateDir, SIDEBAR_BRANDING_SUBDIR);

    const resolveImagePath = (id: string) => path.join(imageDir, id);

    const storeBytes = (input: {
      readonly bytes: Uint8Array;
      readonly declaredMimeType?: string | undefined;
    }) =>
      Effect.gen(function* () {
        const header = yield* validateImageBytes(input);
        const id = makeImageId(input.bytes, header.mimeType);
        const filePath = resolveImagePath(id);
        const exists = yield* fs.exists(filePath).pipe(Effect.catch(() => Effect.succeed(false)));
        if (!exists) {
          const tempFileId = yield* Random.nextUUIDv4;
          yield* fs.makeDirectory(imageDir, { recursive: true });
          const tempDirectory = yield* fs.makeTempDirectoryScoped({
            directory: imageDir,
            prefix: `${id}.`,
          });
          const tempPath = path.join(tempDirectory, `${tempFileId}.tmp`);
          yield* fs.writeFile(tempPath, input.bytes);
          yield* fs.rename(tempPath, filePath);
        }
        return assetFromStoredBytes({ id, bytes: input.bytes, header });
      }).pipe(
        Effect.scoped,
        Effect.mapError((cause) =>
          cause instanceof BrandingImageError
            ? cause
            : new BrandingImageError({
                code: "storage-failed",
                status: 500,
                message: "Sidebar image could not be stored.",
                cause,
              }),
        ),
      );

    return {
      storeUploadedImage: (input) => storeBytes(input),
      storeLegacyDataUrl: (dataUrl) =>
        Effect.gen(function* () {
          const parsed = parseBase64DataUrl(dataUrl);
          if (!parsed) {
            return yield* new BrandingImageError({
              code: "invalid-data-url",
              status: 400,
              message: "Legacy sidebar image data URL is invalid.",
            });
          }

          const bytes = Buffer.from(parsed.base64, "base64");
          return yield* storeBytes({
            bytes,
            declaredMimeType: parsed.mimeType,
          });
        }),
      resolveStoredImage: (id) =>
        Effect.gen(function* () {
          yield* assertValidImageId(id);
          const mimeType = mimeTypeForId(id);
          if (!mimeType) {
            return yield* new BrandingImageError({
              code: "invalid-id",
              status: 404,
              message: "Sidebar image was not found.",
            });
          }
          const filePath = resolveImagePath(id);
          const exists = yield* fs.exists(filePath).pipe(Effect.catch(() => Effect.succeed(false)));
          if (!exists) {
            return yield* new BrandingImageError({
              code: "not-found",
              status: 404,
              message: "Sidebar image was not found.",
            });
          }
          return { id, filePath, mimeType };
        }),
    } satisfies BrandingImageStoreShape;
  });
}

export const BrandingImageStoreLive = Layer.effect(BrandingImageStore, makeBrandingImageStore());
