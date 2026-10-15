import { GENERATED_VISUALIZATION_FONT_FAMILY_STYLE } from "./chatTypography.ts";
import {
  VISUALIZATION_FONT_DATA,
  VISUALIZATION_FONT_LICENSE,
  VISUALIZATION_FONT_LICENSE_SHA256,
  type VisualizationFontData,
} from "./visualizationFontData.ts";

const unavailable = () => new Error("Generated visualization typography is unavailable.");
const MAX_FONT_BYTES = 76248;
const MIN_WOFF2_BYTES = 48;
/** Minimal structural browser contract, deliberately independent of lib.dom.
 * Server export consumers compile with Node-only libs and never load faces.
 * Passing the actual isolated/fixture FontFace constructor infers its complete
 * native DOM type; no browser globals are added to the server type environment. */
export interface LoadedVisualizationFontFace {
  readonly status: "unloaded" | "loading" | "loaded" | "error";
  load(): Promise<LoadedVisualizationFontFace>;
}
export interface VisualizationFontFaceConstructor<Face extends LoadedVisualizationFontFace> {
  new (
    family: string,
    bytes: ArrayBuffer,
    descriptors: {
      style: "normal" | "italic";
      weight: string;
      unicodeRange: string;
      display: "swap";
    },
  ): Face;
}
const digestHex = async (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

/** Bounded fixed-payload admission, exported separately for malformed-byte
 * regressions. The production loader below never accepts received payloads,
 * descriptors or URLs: it calls this only with the four committed local faces.
 * Validate encoded size and canonical padding before allocating an exact buffer,
 * then bind WOFF2 type/header length and SHA-256 before handing it to Chromium. */
export async function decodeVisualizationFontBytes(
  payload: string,
  expected: Pick<VisualizationFontData, "byteLength" | "sha256">,
): Promise<ArrayBuffer> {
  try {
    if (
      !Number.isSafeInteger(expected.byteLength) ||
      expected.byteLength < MIN_WOFF2_BYTES ||
      expected.byteLength > MAX_FONT_BYTES ||
      !/^[a-f0-9]{64}$/.test(expected.sha256) ||
      payload.length !== 4 * Math.ceil(expected.byteLength / 3) ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(payload) ||
      typeof globalThis.atob !== "function" ||
      typeof globalThis.btoa !== "function" ||
      typeof globalThis.crypto?.subtle?.digest !== "function"
    )
      throw unavailable();
    const decoded = globalThis.atob(payload);
    if (decoded.length !== expected.byteLength || globalThis.btoa(decoded) !== payload)
      throw unavailable();
    const buffer = new ArrayBuffer(expected.byteLength);
    const bytes = new Uint8Array(buffer);
    for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index);
    const header = new DataView(buffer);
    if (
      header.getUint32(0, false) !== 0x774f4632 ||
      header.getUint32(8, false) !== expected.byteLength ||
      (await digestHex(buffer)) !== expected.sha256
    )
      throw unavailable();
    return buffer;
  } catch {
    // Browser parsing/crypto diagnostics must not accidentally become received
    // source details or a fallback that claims the actual chat face was loaded.
    throw unavailable();
  }
}

/** Load only Cafe's fixed generated-document faces, without network/font URLs,
 * document mutation, retries, timers or a process-global font cache. The owning
 * isolated preload keeps its inert bootstrap heartbeat and existing absolute
 * startup deadline while this finite work runs; it adds all returned faces to
 * the replacement document before parsing source. Apps return before touching
 * browser APIs. A trusted fixture may supply its exact child-realm constructor,
 * never received font bytes, source-controlled descriptors or an asset path. */
export async function loadGeneratedVisualizationFontFaces<
  Face extends LoadedVisualizationFontFace = LoadedVisualizationFontFace,
>(
  kind: "generated" | "mcp-app",
  FontFaceConstructor?: VisualizationFontFaceConstructor<Face>,
): Promise<readonly Face[]> {
  if (kind !== "generated") return Object.freeze([]);
  try {
    const constructor =
      FontFaceConstructor ??
      (globalThis as typeof globalThis & { FontFace?: VisualizationFontFaceConstructor<Face> })
        .FontFace;
    if (
      typeof constructor !== "function" ||
      typeof globalThis.TextEncoder !== "function" ||
      typeof globalThis.crypto?.subtle?.digest !== "function"
    )
      throw unavailable();
    // Retain the full readable OFL in emitted native code, not merely a dead
    // exported notice that a bundler could discard while distributing fonts.
    // This small fixed commitment also refuses a corrupted bundled license.
    const licenseBytes = new TextEncoder().encode(VISUALIZATION_FONT_LICENSE);
    if (
      licenseBytes.byteLength !== 4502 ||
      (await digestHex(licenseBytes.buffer)) !== VISUALIZATION_FONT_LICENSE_SHA256
    )
      throw unavailable();
    const faces: Face[] = [];
    for (const descriptor of VISUALIZATION_FONT_DATA) {
      const bytes = await decodeVisualizationFontBytes(descriptor.base64, descriptor);
      const face = new constructor("DM Sans Variable", bytes, {
        style: descriptor.style,
        weight: descriptor.weight,
        unicodeRange: descriptor.unicodeRange,
        display: "swap",
      });
      const loaded = await face.load();
      if (loaded !== face || face.status !== "loaded") throw unavailable();
      faces.push(face);
    }
    // No partial publication: callers only receive the complete four-face set.
    return Object.freeze(faces);
  } catch {
    throw unavailable();
  }
}

/** Derived portable documents run outside Cafe's native sandbox after explicit
 * export disclosure. Embed the same exact four faces and complete license, not
 * a CDN or a rewritten received source. Native user-origin priority remains a
 * separate host guarantee; ordinary portable HTML carries author-important
 * family defaults, preserves semantic code, and never intercepts canvas APIs.
 * Exporters reserve this appendix's actual UTF-8 bytes before asset expansion. */
// This expression has only fixed immutable inputs and no observable effects.
// Native imports use the binary loader, not portable CSS; the pure annotation
// lets its bundler remove this unused ~286 KiB derived string allocation while
// retaining font bytes and the full OFL actually verified by that loader.
export const GENERATED_VISUALIZATION_FONT_APPENDIX = /* @__PURE__ */ (() =>
  "\n<style data-cafe-chat-typography>\n/*\n" +
  VISUALIZATION_FONT_LICENSE +
  "\n*/\n" +
  VISUALIZATION_FONT_DATA.map(
    (face) =>
      '@font-face{font-family:"DM Sans Variable";' +
      `font-style:${face.style};font-display:swap;font-weight:${face.weight};` +
      `src:url(data:font/woff2;base64,${face.base64}) format("woff2-variations");` +
      `unicode-range:${face.unicodeRange}}`,
  ).join("\n") +
  "\n" +
  GENERATED_VISUALIZATION_FONT_FAMILY_STYLE +
  "\n</style>")();
