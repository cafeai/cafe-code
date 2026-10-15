/** Fixed content samples for the synthetic clipped/scrolling black document.
 * Native legacy scrollbars belong to the viewport gutter, not the authored
 * page. Three lower interior samples independently verify opaque black content
 * without hiding native controls or treating a native gutter as page pixels.
 * This helper is fixture-only and does not admit production image/source data. */
export function nativeFixtureClippedSampleOffsets(
  width: number,
  height: number,
): readonly number[] | undefined {
  if (
    !Number.isSafeInteger(width) ||
    width < 80 ||
    width > 1600 ||
    !Number.isSafeInteger(height) ||
    height < 80 ||
    height > 2000
  )
    return undefined;
  const y = height - 10;
  return [1, 2, 3].map((quarter) => (y * width + Math.floor((width * quarter) / 4)) * 4);
}

/** Preserve full bitmap length plus exact BGRA/alpha at every known content
 * point. A short image, transparent black, wrong channel or corrupted selected
 * pixel is not a successful native capture merely because dimensions match. */
export function hasNativeFixtureClippedBlackContent(
  bitmap: Uint8Array,
  width: number,
  height: number,
): boolean {
  const offsets = nativeFixtureClippedSampleOffsets(width, height);
  return (
    offsets !== undefined &&
    bitmap.length === width * height * 4 &&
    offsets.every(
      (offset) =>
        bitmap[offset] === 0 &&
        bitmap[offset + 1] === 0 &&
        bitmap[offset + 2] === 0 &&
        bitmap[offset + 3] === 255,
    )
  );
}
