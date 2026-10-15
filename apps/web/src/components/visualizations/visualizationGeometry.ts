const MAX_ANCESTORS = 128;
const MAX_GEOMETRY_EXTENT = 32768;
const CLIPPED_OVERFLOW = new Set(["auto", "scroll", "hidden", "clip"]);
interface InlineBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Only the parent shell's exact frame anchor and ancestors supply geometry.
 * Ordinary browser clipping owns the inline frame's visible region; this walk
 * observes that region without inspecting the authored child document. Keep
 * the walk finite and refuse actual hidden styles or unexpectedly deep trees.
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
 * The complete actual DOM rectangle and its visible crop are distinct finite
 * CSS-coordinate values. Never truncate to a former native surface's prefix:
 * a wide or transformed/tall frame can expose only its far edge and still be
 * visible. Refuse unreasonable geometry explicitly rather than misclassifying
 * that edge as offscreen or changing the child document's responsive viewport.
 */
export function visualizationGeometry(
  element: HTMLElement,
  inspectionHidden = false,
): {
  bounds: InlineBounds;
  clipBounds: InlineBounds;
} | null {
  // Ordinary DOM modals may make their background inert without moving this
  // frame out of view. This mode preserves that existing frame's identity;
  // actual hidden styles, disconnection and finite clipping still deny it.
  const ancestors = visualizationClippingAncestors(element, inspectionHidden);
  if (!ancestors) return null;
  const rect = element.getBoundingClientRect();
  const x = Math.ceil(rect.left),
    y = Math.ceil(rect.top);
  const width = Math.floor(rect.right) - x;
  const height = Math.floor(rect.bottom) - y;
  if (
    ![x, y, width, height, window.innerWidth, window.innerHeight].every(Number.isFinite) ||
    Math.abs(x) > MAX_GEOMETRY_EXTENT ||
    Math.abs(y) > MAX_GEOMETRY_EXTENT ||
    width < 1 ||
    height < 1 ||
    width > MAX_GEOMETRY_EXTENT ||
    height > MAX_GEOMETRY_EXTENT
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
