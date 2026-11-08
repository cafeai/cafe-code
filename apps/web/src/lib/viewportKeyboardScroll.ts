import type { KeyboardEvent as ReactKeyboardEvent } from "react";

// Arrow callers own only a small physical line step. The separate End handler
// is an explicit opt-in for the quota region, not an expansion of viewer keys.
// Page/Home, selection and editing commands remain native.
export const VIEWPORT_ARROW_SCROLL_STEP = 40;

interface ViewportScrollGeometry {
  readonly scrollLeft: number;
  readonly scrollTop: number;
  readonly scrollWidth: number;
  readonly scrollHeight: number;
  readonly clientWidth: number;
  readonly clientHeight: number;
  readonly direction: "ltr" | "rtl";
}

/** Validate both axes before any write, including the coordinate kept intact. */
function getViewportScrollBounds(geometry: ViewportScrollGeometry) {
  if (
    ![
      geometry.scrollLeft,
      geometry.scrollTop,
      geometry.scrollWidth,
      geometry.scrollHeight,
      geometry.clientWidth,
      geometry.clientHeight,
    ].every(Number.isFinite) ||
    geometry.scrollWidth < 0 ||
    geometry.scrollHeight < 0 ||
    geometry.clientWidth <= 0 ||
    geometry.clientHeight <= 0 ||
    (geometry.direction !== "ltr" && geometry.direction !== "rtl")
  )
    return undefined;

  const horizontalMaximum = Math.max(0, geometry.scrollWidth - geometry.clientWidth);
  const verticalMaximum = Math.max(0, geometry.scrollHeight - geometry.clientHeight);
  // Modern native RTL scrollLeft runs from -maximum to zero. Physical arrows
  // keep their signs rather than reversing again with the text direction.
  const minimumLeft = geometry.direction === "rtl" ? -horizontalMaximum : 0;
  const maximumLeft = geometry.direction === "rtl" ? 0 : horizontalMaximum;
  // Refuse elasticity on either axis: even writing the other axis's unchanged
  // coordinate through scrollTo could otherwise clamp an unrelated bounce.
  if (
    geometry.scrollLeft < minimumLeft ||
    geometry.scrollLeft > maximumLeft ||
    geometry.scrollTop < 0 ||
    geometry.scrollTop > verticalMaximum
  )
    return undefined;
  return { minimumLeft, maximumLeft, verticalMaximum };
}

/** Calculate a physical arrow move without changing the other scroll axis. */
export function getViewportArrowScrollTarget(
  key: string,
  geometry: ViewportScrollGeometry,
): { left: number; top: number } | undefined {
  const horizontal = key === "ArrowLeft" || key === "ArrowRight";
  if (!horizontal && key !== "ArrowUp" && key !== "ArrowDown") return undefined;
  const bounds = getViewportScrollBounds(geometry);
  if (!bounds) return undefined;
  const { minimumLeft, maximumLeft, verticalMaximum } = bounds;
  const minimum = horizontal ? minimumLeft : 0;
  const upper = horizontal ? maximumLeft : verticalMaximum;
  const current = horizontal ? geometry.scrollLeft : geometry.scrollTop;
  const sign = key === "ArrowLeft" || key === "ArrowUp" ? -1 : 1;
  const next = Math.min(upper, Math.max(minimum, current + sign * VIEWPORT_ARROW_SCROLL_STEP));
  if (next === current) return undefined;
  return {
    left: horizontal ? next : geometry.scrollLeft,
    top: horizontal ? geometry.scrollTop : next,
  };
}

/** Reach the last quota row without changing horizontal position or direction. */
export function getViewportEndScrollTarget(
  geometry: ViewportScrollGeometry,
): { left: number; top: number } | undefined {
  const bounds = getViewportScrollBounds(geometry);
  if (!bounds || geometry.scrollTop === bounds.verticalMaximum) return undefined;
  return { left: geometry.scrollLeft, top: bounds.verticalMaximum };
}

/**
 * Descendant controls, cells, links and editable/selected text keep their own
 * keyboard behavior. Never move focus or selection to manufacture ownership.
 */
function isFocusedViewportKeyEvent(event: ReactKeyboardEvent<HTMLElement>): boolean {
  if (
    event.defaultPrevented ||
    event.nativeEvent.defaultPrevented ||
    !event.cancelable ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.nativeEvent.isComposing ||
    event.nativeEvent.keyCode === 229
  )
    return false;
  const viewport = event.currentTarget;
  return (
    event.target === viewport &&
    viewport.ownerDocument.activeElement === viewport &&
    viewport.isConnected &&
    !viewport.isContentEditable &&
    viewport.closest("[inert], [hidden]") === null &&
    viewport.ownerDocument.getSelection()?.isCollapsed !== false
  );
}

export function isFocusedViewportArrowKey(event: ReactKeyboardEvent<HTMLElement>): boolean {
  return (
    ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) &&
    isFocusedViewportKeyEvent(event)
  );
}

/**
 * Use an instant native scroll for this focused viewport. Observed Chromium
 * keyboard animations can finish without applying a scroll offset. Own this
 * small offset change rather than replaying input or changing wheel, pointer
 * pan, focus, selection or surrounding keyboard policy.
 */
export function scrollViewportOnArrowKey(event: ReactKeyboardEvent<HTMLElement>): boolean {
  if (!isFocusedViewportArrowKey(event)) return false;
  return scrollFocusedViewport(
    event,
    (geometry) => getViewportArrowScrollTarget(event.key, geometry),
    event.key === "ArrowLeft" || event.key === "ArrowRight",
    event.key === "ArrowLeft" || event.key === "ArrowUp",
  );
}

/**
 * Only the quota's focused read-only region opts into an explicit End command.
 * The native End animation was observed to return without moving that region;
 * do not replay the key or intercept modified/selection/descendant navigation.
 * Existing expanded viewers retain their arrow-only policy and native End.
 */
export function scrollViewportOnEndKey(event: ReactKeyboardEvent<HTMLElement>): boolean {
  if (event.key !== "End" || !isFocusedViewportKeyEvent(event)) return false;
  return scrollFocusedViewport(event, getViewportEndScrollTarget, false, false);
}

/** One synchronous write/readback path; callers qualify their exact key first. */
function scrollFocusedViewport(
  event: ReactKeyboardEvent<HTMLElement>,
  getTarget: (geometry: ViewportScrollGeometry) => { left: number; top: number } | undefined,
  horizontal: boolean,
  negative: boolean,
): boolean {
  const viewport = event.currentTarget;
  const view = viewport.ownerDocument.defaultView;
  if (!view) return false;
  const beforeLeft = viewport.scrollLeft;
  const beforeTop = viewport.scrollTop;
  const direction = view.getComputedStyle(viewport).direction;
  if (direction !== "ltr" && direction !== "rtl") return false;
  const target = getTarget({
    scrollLeft: beforeLeft,
    scrollTop: beforeTop,
    scrollWidth: viewport.scrollWidth,
    scrollHeight: viewport.scrollHeight,
    clientWidth: viewport.clientWidth,
    clientHeight: viewport.clientHeight,
    direction,
  });
  if (!target) return false;
  viewport.scrollTo({ ...target, behavior: "instant" });
  // Only an actually consumed move prevents native default/ancestor scrolling.
  // This also leaves a refused/clamped write at a boundary unhandled.
  const before = horizontal ? beforeLeft : beforeTop;
  const after = horizontal ? viewport.scrollLeft : viewport.scrollTop;
  if (!Number.isFinite(after) || (negative ? after >= before : after <= before)) return false;
  event.preventDefault();
  event.stopPropagation();
  return true;
}
