/**
 * Resolve the layout used by responsive presentation surfaces.
 *
 * A narrow viewport always uses the mobile layout. The operator preference
 * can also force that layout on a wider screen, but it cannot force a narrow
 * screen into the desktop layout.
 */
export function resolveMobileLayout(
  viewportMatchesMobile: boolean,
  mobileOptimizedPresentation: boolean,
): boolean {
  return viewportMatchesMobile || mobileOptimizedPresentation;
}
