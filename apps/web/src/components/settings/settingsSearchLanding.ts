/**
 * Reveals a Settings search result after navigation: waits for its anchor to
 * render, scrolls it to the middle of the page, tints it briefly and moves
 * keyboard focus to the row's control.
 *
 * Anchors are `data-settings-search-id` attributes written by SettingsRow,
 * SettingsSection and provider cards. Pages can render their content after a
 * data load (Providers, Connections), so the anchor is awaited with a bounded
 * MutationObserver rather than assumed present. A missing anchor is not an
 * error: the page was still opened.
 *
 * The highlight is a data attribute rather than a class so a React re-render
 * of the row's `className` cannot remove it mid-animation.
 */

/** Long enough for a page's first data load, short enough to never surprise. */
const ANCHOR_WAIT_MS = 3_000;
/** Matches the CSS animation length; also a fallback if animationend is lost. */
const HIGHLIGHT_MS = 1_660;
export const SETTINGS_SEARCH_HIGHLIGHT_ATTRIBUTE = "data-settings-search-highlight";

const FOCUSABLE = [
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  "[role='switch']:not([aria-disabled='true'])",
  "[role='combobox']:not([aria-disabled='true'])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function findAnchor(root: ParentNode, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-settings-search-id="${CSS.escape(id)}"]`);
}

function waitForAnchor(
  root: HTMLElement,
  id: string,
  signal: AbortSignal,
): Promise<HTMLElement | null> {
  const existing = findAnchor(root, id);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: HTMLElement | null) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => finish(null);
    const observer = new MutationObserver(() => {
      const anchor = findAnchor(root, id);
      if (anchor) finish(anchor);
    });
    const timer = setTimeout(() => finish(null), ANCHOR_WAIT_MS);
    signal.addEventListener("abort", onAbort, { once: true });
    observer.observe(root, { childList: true, subtree: true });
  });
}

/** The row's own control first; never the title's reset or info buttons. */
function focusTargetFor(anchor: HTMLElement): HTMLElement | null {
  const control = anchor.querySelector<HTMLElement>(
    `[data-settings-row-control] :is(${FOCUSABLE})`,
  );
  if (control) return control;
  for (const candidate of anchor.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if (candidate.closest("[data-settings-row-heading]")) continue;
    if (candidate.closest("[data-settings-search-id]") !== anchor) continue;
    return candidate;
  }
  return null;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

let activeHighlight: { element: HTMLElement; cleanup: () => void } | null = null;

export function clearSettingsSearchHighlight(): void {
  activeHighlight?.cleanup();
}

function highlight(anchor: HTMLElement): void {
  clearSettingsSearchHighlight();
  const timer = setTimeout(() => cleanup(), HIGHLIGHT_MS + 200);
  // Sections animate their card child; the event bubbles to the anchor.
  const onAnimationEnd = (event: AnimationEvent) => {
    if (event.animationName.startsWith("cafe-settings-search-")) cleanup();
  };
  // Any deliberate interaction with the page ends the tint early.
  const onInteraction = () => cleanup();
  function cleanup() {
    clearTimeout(timer);
    anchor.removeAttribute(SETTINGS_SEARCH_HIGHLIGHT_ATTRIBUTE);
    anchor.removeEventListener("animationend", onAnimationEnd);
    window.removeEventListener("pointerdown", onInteraction, true);
    window.removeEventListener("wheel", onInteraction, true);
    if (activeHighlight?.element === anchor) activeHighlight = null;
  }
  anchor.setAttribute(SETTINGS_SEARCH_HIGHLIGHT_ATTRIBUTE, "");
  anchor.addEventListener("animationend", onAnimationEnd);
  window.addEventListener("pointerdown", onInteraction, { capture: true, passive: true });
  window.addEventListener("wheel", onInteraction, { capture: true, passive: true });
  activeHighlight = { element: anchor, cleanup };
}

/**
 * Owned here rather than by the sidebar component: on narrow windows opening a
 * result closes (and can unmount) the sidebar sheet, which must not cancel the
 * reveal. Only a newer reveal supersedes an older one.
 */
let activeReveal: AbortController | null = null;

/**
 * Resolves true once the result is revealed (page entries need no anchor).
 * A newer reveal aborts this one without side effects; leaving Settings simply
 * lets the bounded anchor wait expire.
 */
export async function revealSettingsSearchTarget(input: {
  readonly id: string;
  readonly kind: "page" | "setting";
  readonly root: HTMLElement;
}): Promise<boolean> {
  activeReveal?.abort();
  const controller = new AbortController();
  activeReveal = controller;
  const { signal } = controller;
  clearSettingsSearchHighlight();
  if (input.kind === "page") return true;
  const anchor = await waitForAnchor(input.root, input.id, signal);
  if (!anchor || signal.aborted) return false;
  // One frame lets the page's entrance layout settle before measuring.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  if (signal.aborted || !anchor.isConnected) return false;
  anchor.scrollIntoView({
    block: "center",
    behavior: prefersReducedMotion() ? "auto" : "smooth",
  });
  highlight(anchor);
  if (anchor.dataset.settingsSearchTarget === "row") {
    focusTargetFor(anchor)?.focus({ preventScroll: true });
  }
  return true;
}
