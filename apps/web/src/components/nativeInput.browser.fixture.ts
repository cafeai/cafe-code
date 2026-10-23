/** Passive, bounded evidence for synthetic native-browser fixtures. Nothing in
 * this observer grants focus, changes selection, scrolls, prevents input, or
 * changes animation/media policy. A failed observation is not a cause claim.
 * Never record text, DOM markup, arbitrary identifiers, or received errors. */
export function observeNativeInput(
  label: "mermaid-family" | "markdown-table" | "quota-panel" | "scroll-control",
  readOwner: () => HTMLElement | null,
) {
  const started = performance.now();
  const observations: Array<{ phase: string; [field: string]: unknown }> = [];
  const frames = new Set<number>();
  const activationTypes = new Set([
    "pointerdown",
    "mousedown",
    "pointerup",
    "mouseup",
    "click",
    "gotpointercapture",
    "lostpointercapture",
  ]);
  // Retain only these original native events until the caller has awaited its
  // existing action. Capture-listener microtasks need not follow every later
  // dispatch listener, so they are not final default-prevention evidence.
  const activationEvents = new Map<string, Event>();
  let lastKeydown: KeyboardEvent | undefined;
  let lastKeyup: KeyboardEvent | undefined;
  let retired = false;
  let settled = false;
  let failed = false;
  let armed = false;
  let dropped = 0;
  let pointerId: number | undefined;
  let framesArmed = false;
  const finite = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const location = (node: EventTarget | null, owner: HTMLElement | null) =>
    node === owner && owner !== null
      ? "owner"
      : node instanceof Node && owner?.contains(node)
        ? "descendant"
        : node === document.body
          ? "body"
          : node === document || node === window
            ? "document"
            : "other";
  const activationLocation = (node: EventTarget | null, owner: HTMLElement | null) => {
    if (node === owner && owner !== null) return "owner";
    if (!(node instanceof Element) || !owner?.contains(node)) return "other";
    if (node.tagName === "IMG") return "img";
    if (node.tagName === "CANVAS") return "canvas";
    if (node.tagName === "TABLE") return "table";
    return "descendant";
  };
  const editable = (node: Node | null) => {
    const element = node instanceof Element ? node : node?.parentElement;
    return (
      element instanceof HTMLElement &&
      (element.isContentEditable || element.closest("input,textarea") !== null)
    );
  };
  const snapshot = () => {
    const owner = readOwner();
    const style = owner ? getComputedStyle(owner) : null;
    const frame = window.frameElement;
    const selection = document.getSelection();
    const animations = owner?.getAnimations({ subtree: true }) ?? [];
    return {
      connected: owner?.isConnected === true,
      active: location(document.activeElement, owner),
      documentFocused: document.hasFocus(),
      visible: document.visibilityState === "visible",
      parentFocused: frame?.ownerDocument.hasFocus() ?? null,
      parentActiveFrame: frame ? frame.ownerDocument.activeElement === frame : null,
      inert: owner?.closest("[inert]") !== null && owner !== null,
      hidden: owner?.hidden ?? null,
      closed: owner?.hasAttribute("data-closed") ?? null,
      ending: owner?.hasAttribute("data-ending-style") ?? null,
      displayed: style ? style.display !== "none" && style.visibility !== "hidden" : null,
      opacity: style ? finite(Number.parseFloat(style.opacity)) : null,
      pointerBlocked: owner?.parentElement
        ? getComputedStyle(owner.parentElement).pointerEvents === "none"
        : null,
      overflowX: style ? /auto|scroll/.test(style.overflowX) : null,
      overflowY: style ? /auto|scroll/.test(style.overflowY) : null,
      scrollLeft: finite(owner?.scrollLeft),
      scrollTop: finite(owner?.scrollTop),
      scrollWidth: finite(owner?.scrollWidth),
      scrollHeight: finite(owner?.scrollHeight),
      clientWidth: finite(owner?.clientWidth),
      clientHeight: finite(owner?.clientHeight),
      pointerCaptured: owner && pointerId !== undefined ? owner.hasPointerCapture(pointerId) : null,
      selection: selection
        ? {
            type: ["None", "Caret", "Range"].includes(selection.type) ? selection.type : "other",
            collapsed: selection.isCollapsed,
            ranges: Math.min(selection.rangeCount, 32),
            anchor: location(selection.anchorNode, owner),
            focus: location(selection.focusNode, owner),
            anchorAtStart: selection.anchorOffset === 0,
            focusAtStart: selection.focusOffset === 0,
            editable: editable(selection.anchorNode) || editable(selection.focusNode),
          }
        : null,
      timeline: finite(document.timeline.currentTime),
      animationCount: Math.min(animations.length, 1000),
      animations: animations.slice(0, 16).map((animation) => ({
        pending: animation.pending,
        playState: animation.playState,
        currentTime: finite(animation.currentTime),
        endTime: finite(animation.effect?.getComputedTiming().endTime),
      })),
    };
  };
  const record = (phase: string, extra: Record<string, string | number | boolean | null> = {}) => {
    if (retired || !armed) return;
    // Keep the completed activation and key dispatch observations even when
    // later pan/close activity fills the ledger. Otherwise successful controls
    // could discard the very activation needed to compare a failed control.
    // At most seven fixed activation kinds and three key rows are protected;
    // all other observations form a FIFO within the same thirty-record bound.
    const completedAction = (value: string) =>
      value === "after-input" ||
      value === "after-input-keydown" ||
      value === "after-input-keyup" ||
      [...activationTypes].some((type) => value === `after-activation-${type}`);
    if (completedAction(phase)) {
      const previous = observations.findIndex((entry) => entry.phase === phase);
      if (previous !== -1) observations.splice(previous, 1);
    }
    if (observations.length >= 30) {
      dropped = Math.min(dropped + 1, 1_000_000);
      const oldest = observations.findIndex((entry) => !completedAction(entry.phase));
      if (oldest === -1) return;
      observations.splice(oldest, 1);
    }
    try {
      observations.push({ phase, elapsedMs: performance.now() - started, ...extra, ...snapshot() });
    } catch {
      observations.push({ phase, elapsedMs: performance.now() - started, unavailable: true });
    }
  };
  const keyboardFields = (event: KeyboardEvent) => ({
    key: event.key === "End" ? "End" : "ArrowRight",
    code: event.code === "End" || event.code === "ArrowRight" ? event.code : "other",
    keyCode: finite(event.keyCode),
    location: finite(event.location),
    trusted: event.isTrusted,
    target: location(event.target, readOwner()),
    prevented: event.defaultPrevented,
    ctrl: event.ctrlKey,
    meta: event.metaKey,
    alt: event.altKey,
    shift: event.shiftKey,
    repeat: event.repeat,
    composing: event.isComposing,
    exactTarget: event.target === readOwner() && event.target !== null,
  });
  const keyboard = (event: KeyboardEvent) => {
    if (retired || !armed || (event.key !== "ArrowRight" && event.key !== "End")) return;
    if (event.type === "keydown") lastKeydown = event;
    else lastKeyup = event;
    record(event.type, keyboardFields(event));
    queueMicrotask(() => {
      if (!retired) record(`${event.type}-settled`, keyboardFields(event));
    });
  };
  const activationFields = (event: Event) => {
    const owner = readOwner();
    return {
      trusted: event.isTrusted,
      target: location(event.target, owner),
      activationTarget: activationLocation(event.target, owner),
      exactTarget: event.target === owner && owner !== null,
      prevented: event.defaultPrevented,
    };
  };
  const observe = (event: Event) => {
    if (retired || !armed) return;
    if (event instanceof PointerEvent) pointerId = event.pointerId;
    if (activationTypes.has(event.type)) {
      activationEvents.set(event.type, event);
      record(event.type, activationFields(event));
    } else {
      record(event.type, { trusted: event.isTrusted, target: location(event.target, readOwner()) });
    }
  };
  const events = [
    "focus",
    "blur",
    "scroll",
    "selectionchange",
    "pointerdown",
    "mousedown",
    "pointerup",
    "mouseup",
    "click",
    "gotpointercapture",
    "lostpointercapture",
    "transitionrun",
    "transitionend",
    "transitioncancel",
    "animationend",
    "animationcancel",
  ] as const;
  window.addEventListener("keydown", keyboard, true);
  window.addEventListener("keyup", keyboard, true);
  for (const name of events) window.addEventListener(name, observe, true);
  return {
    mark(
      phase:
        | "before-activation"
        | "after-activation"
        | "ready"
        | "before-input"
        | "after-input"
        | "before-exit"
        | "after-exit",
    ) {
      if (retired) return;
      armed = true;
      if (phase === "before-activation") activationEvents.clear();
      if (phase === "before-input") {
        lastKeydown = undefined;
        lastKeyup = undefined;
      }
      record(phase);
      // These marks follow the original awaited action, not a listener-created
      // microtask. Project fixed fields only; never serialize native objects.
      if (phase === "after-activation") {
        for (const [type, event] of activationEvents)
          record(`after-activation-${type}`, activationFields(event));
      } else if (phase === "after-input") {
        if (lastKeydown) record("after-input-keydown", keyboardFields(lastKeydown));
        if (lastKeyup) record("after-input-keyup", keyboardFields(lastKeyup));
      }
      // Two passive frame receipts can distinguish queued rendering from an
      // observed native frame. They are never awaited or asserted as a budget.
      if (!framesArmed && (phase === "before-input" || phase === "before-exit")) {
        framesArmed = true;
        const first = requestAnimationFrame(() => {
          frames.delete(first);
          if (retired) return;
          record("frame-1");
          const second = requestAnimationFrame(() => {
            frames.delete(second);
            record("frame-2");
          });
          frames.add(second);
        });
        frames.add(first);
      }
    },
    assertActive() {
      if (retired) throw new Error("Native input fixture has retired.");
    },
    complete() {
      settled = true;
    },
    fail() {
      failed = true;
      settled = true;
    },
    retire() {
      if (retired) return;
      let final: unknown;
      try {
        final = snapshot();
      } catch {
        final = { unavailable: true };
      }
      retired = true;
      lastKeydown = undefined;
      lastKeyup = undefined;
      activationEvents.clear();
      window.removeEventListener("keydown", keyboard, true);
      window.removeEventListener("keyup", keyboard, true);
      for (const name of events) window.removeEventListener(name, observe, true);
      for (const frame of frames) cancelAnimationFrame(frame);
      frames.clear();
      // Retain positive receipts during diagnosis too: a diagnostic pass alone
      // cannot explain a historical failure, but its native state can be
      // compared without changing or replaying the admitted input.
      console.info(
        "native-input-diagnostic",
        JSON.stringify({ label, settled, failed, observations, dropped, final }),
      );
    },
  };
}
