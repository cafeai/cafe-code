import { DESKTOP_APP_ICON_SIZE, type DesktopCustomAppIcon } from "@cafecode/contracts";

async function canvasPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("PNG encoding failed.");
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Center-crops an image to a square and renders the two PNGs the desktop
 * stores: the square artwork for Windows/Linux window icons, and the macOS Dock
 * tile using the same 832/1024 rounded inset as scripts/build-macos-icons.ts so
 * it matches other Dock icons. `pixelated` keeps pixel art crisp when scaling.
 */
export async function renderAppIconPngs(
  source: Blob,
  options: { readonly size?: number; readonly pixelated?: boolean } = {},
): Promise<DesktopCustomAppIcon> {
  const size = options.size ?? DESKTOP_APP_ICON_SIZE;
  const smoothing = options.pixelated !== true;
  const bitmap = await createImageBitmap(source);
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const sx = (bitmap.width - side) / 2;
    const sy = (bitmap.height - side) / 2;

    const full = document.createElement("canvas");
    full.width = size;
    full.height = size;
    const fullContext = full.getContext("2d");
    if (!fullContext) throw new Error("Canvas is unavailable.");
    fullContext.imageSmoothingEnabled = smoothing;
    fullContext.imageSmoothingQuality = "high";
    fullContext.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);

    const mac = document.createElement("canvas");
    mac.width = size;
    mac.height = size;
    const macContext = mac.getContext("2d");
    if (!macContext) throw new Error("Canvas is unavailable.");
    const inset = (size * 96) / 1024;
    const tile = size - inset * 2;
    macContext.beginPath();
    macContext.roundRect(inset, inset, tile, tile, (tile * 184) / 832);
    macContext.clip();
    macContext.imageSmoothingEnabled = true;
    macContext.imageSmoothingQuality = "high";
    macContext.drawImage(full, inset, inset, tile, tile);

    return { png: await canvasPngBytes(full), macPng: await canvasPngBytes(mac) };
  } finally {
    bitmap.close();
  }
}
