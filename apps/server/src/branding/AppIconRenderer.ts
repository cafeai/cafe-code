import { createHash } from "node:crypto";
import * as Data from "effect/Data";
// Native image admission keeps bounded no-follow reads and exact held-file identity.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { constants } from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { open, lstat } from "node:fs/promises";
import {
  MAX_SIDEBAR_BRAND_IMAGE_DIMENSION,
  MAX_SIDEBAR_BRAND_IMAGE_FILE_BYTES,
  MAX_SIDEBAR_BRAND_IMAGE_PIXEL_COUNT,
} from "@cafecode/contracts/settings";
import {
  WEB_APP_ICON_VARIANTS,
  webAppManifestIcons,
  type WebAppIconVariant,
} from "@cafecode/shared/webAppBranding";
import type { BrandingImageStoreShape } from "./BrandingImageStore.ts";
import { parseImageHeader } from "../rasterImageHeader.ts";

export type AppIconSet = ReadonlyMap<WebAppIconVariant, Uint8Array>;
const MAX_ICON_SET_BYTES = 4 * 1024 * 1024;
const MAX_WAITERS = 16;
const ICON_SIZES: Record<WebAppIconVariant, number> = {
  "touch-180": 180,
  "app-192": 192,
  "app-512": 512,
  "maskable-512": 512,
  "favicon-32": 32,
  "badge-96": 96,
};

export class AppIconRenderError extends Data.TaggedError("AppIconRenderError")<{
  readonly reason: "unavailable" | "busy";
}> {
  constructor(reason: "unavailable" | "busy") {
    super({ reason });
    this.message = "Application icon is unavailable.";
  }
}

async function readImage(filePath: string, imageId: string): Promise<Uint8Array> {
  const file = await open(
    filePath,
    constants.O_RDONLY |
      (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK),
  );
  try {
    const before = await file.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size < 1n ||
      before.size > BigInt(MAX_SIDEBAR_BRAND_IMAGE_FILE_BYTES) ||
      (process.getuid && before.uid !== BigInt(process.getuid()))
    )
      throw new AppIconRenderError("unavailable");
    const bytes = new Uint8Array(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    const after = await file.stat({ bigint: true });
    const named = await lstat(filePath, { bigint: true });
    if (
      BigInt(length) !== before.size ||
      after.size !== before.size ||
      after.nlink !== 1n ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      named.isSymbolicLink() ||
      named.dev !== before.dev ||
      named.ino !== before.ino ||
      named.nlink !== 1n ||
      !named.isFile() ||
      named.size !== before.size ||
      named.mtimeNs !== before.mtimeNs ||
      named.ctimeNs !== before.ctimeNs ||
      !imageId.startsWith(
        `sha256-${createHash("sha256").update(bytes.subarray(0, length)).digest("hex")}.`,
      )
    ) {
      throw new AppIconRenderError("unavailable");
    }
    return bytes.subarray(0, length);
  } finally {
    await file.close();
  }
}

/** Decode only the already-selected bounded raster upload, never SVG, URLs or paths from a client. */
export async function renderAppIconSet(bytes: Uint8Array): Promise<AppIconSet> {
  if (bytes.byteLength > MAX_SIDEBAR_BRAND_IMAGE_FILE_BYTES)
    throw new AppIconRenderError("unavailable");
  const header = parseImageHeader(bytes);
  if (
    !header ||
    header.width < 1 ||
    header.height < 1 ||
    header.width > MAX_SIDEBAR_BRAND_IMAGE_DIMENSION ||
    header.height > MAX_SIDEBAR_BRAND_IMAGE_DIMENSION ||
    header.width * header.height > MAX_SIDEBAR_BRAND_IMAGE_PIXEL_COUNT
  )
    throw new AppIconRenderError("unavailable");
  // Load the existing pinned codec lazily: ordinary backend/provider startup does
  // no native image initialization. Native decoder allocations are not a hard
  // process-RAM sandbox; admission bounds encoded bytes, headers and outputs.
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const image = await loadImage(Buffer.from(bytes));
  const sameDimensions = image.width === header.width && image.height === header.height;
  // Phone JPEGs may rotate their encoded frame through EXIF orientation. A
  // swapped pair has the same already-admitted dimensions and pixel budget.
  const orientedJpeg =
    header.mimeType === "image/jpeg" &&
    image.width === header.height &&
    image.height === header.width;
  if (!sameDimensions && !orientedJpeg) throw new AppIconRenderError("unavailable");
  const result = new Map<WebAppIconVariant, Uint8Array>();
  let total = 0;
  for (const variant of WEB_APP_ICON_VARIANTS) {
    const size = ICON_SIZES[variant];
    const canvas = createCanvas(size, size);
    const context = canvas.getContext("2d");
    if (variant !== "badge-96") {
      context.fillStyle = "#161616";
      context.fillRect(0, 0, size, size);
    }
    // A square within 56% of the canvas fits entirely in a maskable icon's
    // central safe circle. Preserve every upload's aspect ratio, including photos.
    const available = size * (variant === "maskable-512" ? 0.56 : 0.88);
    const scale = Math.min(available / image.width, available / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
    const output = await canvas.encode("png");
    total += output.byteLength;
    if (total > MAX_ICON_SET_BYTES) throw new AppIconRenderError("unavailable");
    result.set(variant, output);
  }
  return result;
}

/** Generic fallback art contains no uploaded/user image and is safe to ship publicly. */
export async function renderNeutralAppIcons(): Promise<AppIconSet> {
  const { createCanvas } = await import("@napi-rs/canvas");
  const canvas = createCanvas(512, 512);
  const context = canvas.getContext("2d");
  context.strokeStyle = "#f5f5f5";
  context.lineWidth = 22;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();
  context.moveTo(126, 204);
  context.lineTo(126, 302);
  context.quadraticCurveTo(126, 366, 204, 366);
  context.lineTo(266, 366);
  context.quadraticCurveTo(344, 366, 344, 302);
  context.lineTo(344, 204);
  context.closePath();
  context.stroke();
  context.beginPath();
  context.moveTo(344, 222);
  context.lineTo(369, 222);
  context.bezierCurveTo(430, 222, 430, 302, 344, 302);
  context.stroke();
  context.beginPath();
  context.moveTo(116, 399);
  context.lineTo(362, 399);
  context.stroke();
  for (const x of [189, 265]) {
    context.beginPath();
    context.moveTo(x, 160);
    context.bezierCurveTo(x - 24, 132, x + 24, 122, x, 94);
    context.stroke();
  }
  return renderAppIconSet(await canvas.encode("png"));
}

export class AppIconRenderer {
  private readonly cache = new Map<string, AppIconSet>();
  private active: { id: string; promise: Promise<AppIconSet>; waiters: number } | null = null;
  private failed: { id: string; until: number } | null = null;

  async render(id: string, filePath: string, variant: WebAppIconVariant): Promise<Uint8Array> {
    const cached = this.cache.get(id);
    if (cached) return cached.get(variant)!;
    if (this.failed?.id === id && this.failed.until > performance.now())
      throw new AppIconRenderError("unavailable");
    if (this.active) {
      const active = this.active;
      if (active.id !== id || active.waiters >= MAX_WAITERS) throw new AppIconRenderError("busy");
      active.waiters += 1;
      try {
        return (await active.promise).get(variant)!;
      } finally {
        active.waiters -= 1;
      }
    }
    const active = { id, promise: readImage(filePath, id).then(renderAppIconSet), waiters: 1 };
    this.active = active;
    try {
      const icons = await active.promise;
      this.cache.set(id, icons);
      while (this.cache.size > 2) this.cache.delete(this.cache.keys().next().value!);
      this.failed = null;
      return icons.get(variant)!;
    } catch {
      this.failed = { id, until: performance.now() + 5_000 };
      throw new AppIconRenderError("unavailable");
    } finally {
      if (this.active === active) this.active = null;
    }
  }
}

// Exact store identity keeps both in-flight work and the two-entry byte cache
// private to one backend/profile. No image bytes enter settings or diagnostics.
const renderers = new WeakMap<BrandingImageStoreShape, AppIconRenderer>();
export function appIconRenderer(store: BrandingImageStoreShape): AppIconRenderer {
  let renderer = renderers.get(store);
  if (!renderer) {
    renderer = new AppIconRenderer();
    renderers.set(store, renderer);
  }
  return renderer;
}

/** Android's WebAPK hasher omits credentials. Carry only these bounded derived
 * PNGs in the authenticated manifest, rather than publishing the private upload
 * or requiring an authenticated follow-up from the installer. */
export async function renderWebAppManifestIcons(
  store: BrandingImageStoreShape,
  id: string,
  filePath: string,
) {
  const icons = webAppManifestIcons(`custom:${id}`);
  const variants = ["app-192", "app-512", "maskable-512"] as const;
  for (const [index, variant] of variants.entries()) {
    const bytes = await appIconRenderer(store).render(id, filePath, variant);
    icons[index]!.src = `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
  }
  return icons;
}
