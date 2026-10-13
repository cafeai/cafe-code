import type { VisualizationHostLayout } from "@cafecode/contracts/visualizationHost";

/** Observe only natural root-flow extent, not the previous viewport's
 * scrollHeight/min-height. Fixed/absolute decoration and tooltips are excluded.
 * Received HTML can intentionally remain viewport dependent; bounded/constrained
 * output is presentation information, not a guarantee about arbitrary source. */
export function measureVisualizationLayout(
  document: Document,
): Omit<VisualizationHostLayout, "sequence"> | undefined {
  const body = document.body;
  if (!body) return;
  const top = body.getBoundingClientRect().top;
  if (!Number.isFinite(top)) return;
  const style = document.defaultView?.getComputedStyle(body);
  if (!style) return;
  const padding = Number.parseFloat(style.paddingBottom) || 0;
  if (!Number.isFinite(padding) || padding < 0) return;
  let height = 0;
  let count = 0;
  for (let node = body.firstChild; node; node = node.nextSibling) {
    // No history-sized child array or subtree walk. Too many root children is
    // honestly constrained rather than partially measured as complete content.
    if (++count > 128) return { height: 2000, constrained: true };
    let bottom: number;
    let margin = 0;
    if (node.nodeType === 1) {
      const element = node as Element;
      const childStyle = document.defaultView!.getComputedStyle(element);
      if (
        ["none"].includes(childStyle.display) ||
        ["fixed", "absolute"].includes(childStyle.position)
      )
        continue;
      bottom = element.getBoundingClientRect().bottom;
      margin = Number.parseFloat(childStyle.marginBottom) || 0;
    } else if (node.nodeType === 3) {
      const range = document.createRange();
      range.selectNodeContents(node);
      bottom = range.getBoundingClientRect().bottom;
    } else continue;
    if (!Number.isFinite(bottom) || !Number.isFinite(margin)) return;
    height = Math.max(height, bottom - top + Math.max(0, margin));
  }
  const natural = Math.ceil(height + padding);
  if (!Number.isSafeInteger(natural) || natural < 0) return;
  return { height: Math.max(80, Math.min(2000, natural)), constrained: natural > 2000 };
}

const layoutIsVisible = () =>
  document.documentElement.dataset.cafeVisible === "true" &&
  document.documentElement.dataset.cafePresentationVisible !== "false" &&
  !document.hidden;

/** Private isolated-preload lifecycle. No page API, raw DOM, source or native
 * authority is exposed. Notifications are coalesced; timers are event-driven,
 * absent while hidden or unchanged and retired exactly on pagehide. */
export function observeVisualizationLayout(
  nonce: string,
  send: (value: VisualizationHostLayout & { nonce: string; contextEpoch: number }) => void,
  context: () => { epoch: number; inline: boolean } = () => ({ epoch: 1, inline: true }),
): () => void {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sequence = 0;
  let previous: Omit<VisualizationHostLayout, "sequence"> | undefined;
  let previousEpoch = 0;
  let previousPaintVisible = document.documentElement.dataset.cafePresentationVisible !== "false";
  let resize: ResizeObserver | undefined;
  let mutation: MutationObserver | undefined;
  const measure = (initial = false) => {
    timer = undefined;
    if (disposed || (!initial && !layoutIsVisible())) return;
    const current = context();
    if (!Number.isSafeInteger(current.epoch) || current.epoch < 1 || current.epoch > 100000) return;
    if (current.epoch !== previousEpoch) {
      previous = undefined;
      previousEpoch = current.epoch;
      sequence = 0;
    }
    if (!current.inline || sequence >= 100000) return;
    const layout = measureVisualizationLayout(document);
    if (
      !layout ||
      (previous?.height === layout.height && previous.constrained === layout.constrained)
    )
      return;
    previous = layout;
    send({ nonce, contextEpoch: current.epoch, sequence: ++sequence, ...layout });
  };
  const schedule = () => {
    if (!disposed && !timer && layoutIsVisible()) timer = setTimeout(() => measure(), 250);
  };
  const visibility = () => {
    if (!layoutIsVisible() && timer) {
      clearTimeout(timer);
      timer = undefined;
    } else schedule();
  };
  const paintVisibility = () => {
    const painted = document.documentElement.dataset.cafePresentationVisible !== "false";
    if (painted === previousPaintVisible) return;
    previousPaintVisible = painted;
    // A measurement can be queued while painted, then be validly consumed and
    // refused by native after pixels hide. There is no acceptance ACK. A real
    // false→true paint transition therefore samples current layout once, even
    // if the page's last sent height is unchanged. Keep the exact continuing
    // nonce/context/sequence and all original finite measurement/rate budgets.
    if (painted) previous = undefined;
    visibility();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    resize?.disconnect();
    mutation?.disconnect();
    window.removeEventListener("cafe-visibility-changed", visibility);
    window.removeEventListener("cafe-presentation-visibility-changed", paintVisibility);
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("cafe-presentation-changed", schedule);
    window.removeEventListener("pagehide", dispose);
  };
  // The initial finite sample can establish natural height before visibility;
  // later samples require actual visibility and never a perpetual polling loop.
  try {
    // Register each exact allocation before the next fallible constructor or
    // observation. A partial native observer failure cannot retain its sibling.
    resize = new ResizeObserver(schedule);
    mutation = new MutationObserver(schedule);
    resize.observe(document.body);
    mutation.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["style", "class", "hidden", "open", "width", "height"],
    });
    window.addEventListener("cafe-visibility-changed", visibility);
    window.addEventListener("cafe-presentation-visibility-changed", paintVisibility);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("cafe-presentation-changed", schedule);
    window.addEventListener("pagehide", dispose, { once: true });
    measure(true);
  } catch {
    dispose();
  }
  return dispose;
}
