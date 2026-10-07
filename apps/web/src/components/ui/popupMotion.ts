/**
 * Shared enter/exit motion for anchored floating panels: menus, popovers,
 * selects, comboboxes, autocompletes and tooltips (docs/style-guide.md §8).
 *
 * The panel fades and scales from 0.96 at its anchor (`--transform-origin`),
 * entering over `--duration-base` with ease-out and leaving faster over
 * `--duration-fast` with ease-in. A CSS transition (rather than a keyframe
 * animation) is deliberate: reopening mid-exit reverses smoothly instead of
 * restarting.
 *
 * Apply it to the Base UI `Popup` part itself, never to a wrapper. Base UI
 * sets `data-starting-style`/`data-ending-style` on the popup and waits only
 * for that element's own `getAnimations()` before unmounting, so a transition
 * on a parent or child would either never start or be cut off at close.
 *
 * Callers add their own `transition-[...]` property list (always including
 * `scale` and `opacity`) because some popups also morph `width`/`height`
 * between triggers. Reduced motion removes the scale globally in index.css and
 * keeps the fade.
 */
export const POPUP_MOTION_CLASS_NAME =
  "origin-(--transform-origin) duration-(--duration-base) ease-out data-starting-style:scale-96 data-starting-style:opacity-0 data-ending-style:scale-96 data-ending-style:opacity-0 data-ending-style:duration-(--duration-fast) data-ending-style:ease-in";
