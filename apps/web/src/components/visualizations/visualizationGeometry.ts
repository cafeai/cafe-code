import type { VisualizationHostBounds } from "@cafecode/contracts/visualizationHost";

const MAX_ANCESTORS = 128;
const CLIPPED_OVERFLOW = new Set(["auto", "scroll", "hidden", "clip"]);

/**
 * Only trusted shell ancestors supply geometry. A native surface is above the
 * DOM compositor, so CSS overflow on the chat/card does not clip it by itself.
 * Keep this walk finite and refuse hidden/inert or unexpectedly deep trees;
 * neither a source document nor an arbitrary selector participates in it.
 */
export function visualizationClippingAncestors(
  element: HTMLElement,
  inspectionHidden = false,
): HTMLElement[] | null {
  if (!element.isConnected || element.ownerDocument !== document) return null;
  const result: HTMLElement[] = [];
  let ancestor: HTMLElement | null = element;
  for (let count = 0; ancestor && count < MAX_ANCESTORS; count += 1) {
    const style = getComputedStyle(ancestor);
    if (
      (!inspectionHidden && ancestor.inert) ||
      (!inspectionHidden && ancestor.getAttribute("aria-hidden") === "true") ||
      style.visibility !== "visible" ||
      style.display === "none"
    )
      return null;
    const paintContained = /\b(paint|strict|content)\b/.test(style.contain);
    if (
      ancestor !== element &&
      (paintContained ||
        CLIPPED_OVERFLOW.has(style.overflowX) ||
        CLIPPED_OVERFLOW.has(style.overflowY))
    )
      result.push(ancestor);
    ancestor = ancestor.parentElement;
  }
  return ancestor ? null : result;
}

/** The padding/client box excludes borders and native scrollbars, even under a scaled shell. */
function clientBox(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const scaleX = element.offsetWidth > 0 ? rect.width / element.offsetWidth : 1;
  const scaleY = element.offsetHeight > 0 ? rect.height / element.offsetHeight : 1;
  const left = rect.left + element.clientLeft * scaleX;
  const top = rect.top + element.clientTop * scaleY;
  return {
    left,
    top,
    right: left + element.clientWidth * scaleX,
    bottom: top + element.clientHeight * scaleY,
  };
}

/**
 * Full page bounds and its visible crop are separate CSS-coordinate values.
 * Scrolling changes only the crop/offset, not the guest's responsive viewport.
 * Main owns CSS-to-DIP conversion and its qualified minimum clipping size; a
 * renderer cannot infer that size from CSS pixels or mutate guest zoom to fit.
 */
export function visualizationGeometry(
  element: HTMLElement,
  inspectionHidden = false,
): {
  bounds: VisualizationHostBounds;
  clipBounds: VisualizationHostBounds;
} | null {
  // Only an already presentation-hidden exact generated viewer uses this
  // narrow mode while its trusted inspector makes the background inert. Real
  // hidden styles, disconnects and finite clipping still fail; this cannot
  // expose native pixels or admit a new source from an inert ancestor.
  const ancestors = visualizationClippingAncestors(element, inspectionHidden);
  if (!ancestors) return null;
  const rect = element.getBoundingClientRect();
  const x = Math.ceil(rect.left),
    y = Math.ceil(rect.top);
  const width = Math.min(1600, Math.floor(rect.right) - x);
  const height = Math.min(2000, Math.floor(rect.bottom) - y);
  if (
    ![x, y, width, height, window.innerWidth, window.innerHeight].every(Number.isFinite) ||
    Math.abs(x) > 32768 ||
    Math.abs(y) > 32768 ||
    width < 1 ||
    height < 1
  )
    return null;
  let left = Math.max(0, x),
    top = Math.max(0, y);
  let right = Math.min(window.innerWidth, x + width);
  let bottom = Math.min(window.innerHeight, y + height);
  for (const ancestor of ancestors) {
    const style = getComputedStyle(ancestor);
    const box = clientBox(ancestor);
    if (![box.left, box.top, box.right, box.bottom].every(Number.isFinite)) return null;
    const paintContained = /\b(paint|strict|content)\b/.test(style.contain);
    if (paintContained || CLIPPED_OVERFLOW.has(style.overflowX)) {
      left = Math.max(left, box.left);
      right = Math.min(right, box.right);
    }
    if (paintContained || CLIPPED_OVERFLOW.has(style.overflowY)) {
      top = Math.max(top, box.top);
      bottom = Math.min(bottom, box.bottom);
    }
  }
  const clipX = Math.ceil(left),
    clipY = Math.ceil(top);
  const clipWidth = Math.floor(right) - clipX,
    clipHeight = Math.floor(bottom) - clipY;
  if (clipWidth < 1 || clipHeight < 1) return null;
  return {
    bounds: { x, y, width, height },
    clipBounds: { x: clipX, y: clipY, width: clipWidth, height: clipHeight },
  };
}

/**
 * Reserve one passive/active slot from the actual chat viewport, not the whole
 * desktop window. Scroll never changes this height: only ancestor/window size
 * changes do, so starting/stopping the native document does not shift history.
 */
export function visualizationInlineHeight(element: HTMLElement): number | null {
  const ancestors = visualizationClippingAncestors(element);
  // A modal makes the original chat inert. Keep its last reserved slot rather
  // than measuring a broader window fallback while that owner is unavailable.
  if (!ancestors) return null;
  let viewportHeight = window.innerHeight;
  for (const ancestor of ancestors) {
    const style = getComputedStyle(ancestor);
    if (CLIPPED_OVERFLOW.has(style.overflowY) || /\b(paint|strict|content)\b/.test(style.contain)) {
      const box = clientBox(ancestor);
      viewportHeight = Math.min(viewportHeight, box.bottom - box.top);
    }
  }
  return Math.max(
    80,
    Math.min(700, Math.floor(viewportHeight * 0.65), Math.floor(viewportHeight - 100)),
  );
}
