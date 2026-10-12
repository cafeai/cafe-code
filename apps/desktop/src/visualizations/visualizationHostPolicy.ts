import type {
  VisualizationHostBounds,
  VisualizationHostDocument,
} from "@cafecode/contracts/visualizationHost";
import {
  VISUALIZATION_HOST_MAX_ASSET_BYTES,
  VISUALIZATION_HOST_MAX_MESSAGE_BYTES,
} from "@cafecode/contracts/visualizationHost";
import { readBoundedMcpAppJson } from "@cafecode/shared/mcpAppJson";

/** No request, navigation or permission policy is inherited from the ordinary app session. */
export const VISUALIZATION_SCHEME = "cafe-visualization";
export const VISUALIZATION_PAGE_CHANNEL = "cafe-visualization:page-data";
export const VISUALIZATION_CONTEXT_CHANNEL = "cafe-visualization:context";
export const VISUALIZATION_HEARTBEAT_CHANNEL = "cafe-visualization:heartbeat";
export const VISUALIZATION_INSTALLED_CHANNEL = "cafe-visualization:installed";
export const VISUALIZATION_FRAME_CHANNEL = "cafe-visualization:frame";
export const VISUALIZATION_EVENT_CHANNEL = "desktop:visualization-event";

export function clampVisualizationBounds(
  bounds: VisualizationHostBounds,
  windowSize: readonly [number, number],
): VisualizationHostBounds | null {
  const [width, height] = windowSize;
  const x = Math.max(0, bounds.x);
  const y = Math.max(0, bounds.y);
  const right = Math.min(width, bounds.x + bounds.width);
  const bottom = Math.min(height, bounds.y + bounds.height);
  if (![x, y, right, bottom].every(Number.isFinite) || right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

/** Bounded JSON relay data, not authorization. Refuse pathological depth/work before parsing. */
export function hasBoundedVisualizationJson(
  value: unknown,
  maximumBytes = VISUALIZATION_HOST_MAX_MESSAGE_BYTES,
): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumBytes ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  )
    return false;
  let depth = 0;
  let tokens = 0;
  let quoted = false;
  let escaped = false;
  for (const character of value) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') {
      quoted = true;
      tokens += 1;
    } else if (character === "{" || character === "[") {
      depth += 1;
      tokens += 1;
    } else if (character === "}" || character === "]") {
      depth -= 1;
      tokens += 1;
    } else if (character === "," || character === ":") tokens += 1;
    if (depth < 0 || depth > 16 || tokens > 4096) return false;
  }
  return !quoted && depth === 0;
}

export function isVisualizationMessage(value: unknown): value is string {
  const decoded = readBoundedMcpAppJson(value);
  return (
    decoded.ok &&
    decoded.value !== null &&
    typeof decoded.value === "object" &&
    !Array.isArray(decoded.value)
  );
}

/** Native response headers survive document.open; the child cannot remove or relax them. */
export const VISUALIZATION_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  `img-src data: ${VISUALIZATION_SCHEME}:`,
  "connect-src 'none'",
  "font-src 'none'",
  "worker-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "media-src 'none'",
].join("; ");

/** A bounded header scan precedes native raster decoding, including decompression allocation. */
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
    // JPEG metadata may be large, but the finite encoded-byte budget also bounds
    // this nonallocating scan. Refuse scan/entropy data before an admitted SOF.
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
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (length < 8) return null;
        height = bytes.readUInt16BE(offset + 5);
        width = bytes.readUInt16BE(offset + 7);
        break;
      }
      offset += length + 2;
    }
  } else {
    if (
      bytes.length < 30 ||
      bytes.toString("ascii", 0, 4) !== "RIFF" ||
      bytes.toString("ascii", 8, 12) !== "WEBP"
    )
      return null;
    const kind = bytes.toString("ascii", 12, 16);
    if (kind === "VP8X") {
      if (bytes.readUInt32LE(16) !== 10 || (bytes[20]! & 2) !== 0) return null; // No animated imported assets.
      width = bytes.readUIntLE(24, 3) + 1;
      height = bytes.readUIntLE(27, 3) + 1;
    } else if (
      kind === "VP8 " &&
      bytes.length >= 30 &&
      bytes.toString("hex", 23, 26) === "9d012a"
    ) {
      width = bytes.readUInt16LE(26) & 0x3fff;
      height = bytes.readUInt16LE(28) & 0x3fff;
    } else if (kind === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
    } else return null;
  }
  return width > 0 && height > 0 && width <= 4096 && height <= 4096 && width * height <= 8_000_000
    ? { width, height }
    : null;
}

/** One actual process must never be shared with another WebContents owner. */
export function hasExclusiveVisualizationProcesses(
  ownProcesses: readonly number[],
  otherProcesses: readonly number[],
): boolean {
  return (
    ownProcesses.length === 1 &&
    otherProcesses.every((pid) => Number.isSafeInteger(pid) && pid > 0) &&
    ownProcesses.every(
      (pid) => Number.isSafeInteger(pid) && pid > 0 && !otherProcesses.includes(pid),
    )
  );
}
