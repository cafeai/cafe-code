/** The encoded output remains 1600×2000/3.2M pixels. A separately bounded native
 * temporary may contain 12.8M pixels (51.2MB raw RGBA); normalization retains a
 * separate at-most 3.2M-pixel/12.8MB raw copy plus finite encoded buffers. These
 * are conservative image-work envelopes, never total-process-memory claims. */
export const MAX_VISUALIZATION_PHYSICAL_CAPTURE_PIXELS = 12_800_000;

export interface VisualizationCaptureTuple {
  readonly width: number;
  readonly height: number;
  readonly physicalWidth: number;
  readonly physicalHeight: number;
  readonly dpr: number;
}

/** Exact owner-display metadata must be available before native capture. */
export function admitVisualizationCapture(
  width: number,
  height: number,
  dpr: unknown,
): VisualizationCaptureTuple | null {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    width > 1600 ||
    height < 1 ||
    height > 2000 ||
    width * height > 3_200_000 ||
    typeof dpr !== "number" ||
    !Number.isFinite(dpr) ||
    dpr < 0.5 ||
    dpr > 4
  )
    return null;
  const physicalWidth = Math.ceil(width * dpr);
  const physicalHeight = Math.ceil(height * dpr);
  if (physicalWidth * physicalHeight > MAX_VISUALIZATION_PHYSICAL_CAPTURE_PIXELS) return null;
  return { width, height, physicalWidth, physicalHeight, dpr };
}

/** CopyOutputResult's enclosing native raster must match the admitted tuple. */
export function matchesVisualizationCapture(
  tuple: VisualizationCaptureTuple,
  size: { readonly width: number; readonly height: number },
): boolean {
  return size.width === tuple.physicalWidth && size.height === tuple.physicalHeight;
}
