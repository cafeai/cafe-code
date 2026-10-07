import { useEffect, useState } from "react";

/**
 * Loading indicators should not flash for fast work (docs/style-guide.md §9):
 * wait before showing them, and once shown keep them up long enough to read.
 */
export const DELAYED_FLAG_SHOW_DELAY_MS = 250;
export const DELAYED_FLAG_MIN_VISIBLE_MS = 300;

export interface DelayedFlagTiming {
  readonly delayMs: number;
  readonly minVisibleMs: number;
}

export interface DelayedFlagState {
  readonly visible: boolean;
  /** Clock time when the indicator became visible, or null while hidden. */
  readonly shownAtMs: number | null;
}

export type DelayedFlagStep =
  | { readonly kind: "settled" }
  | { readonly kind: "schedule"; readonly afterMs: number; readonly next: DelayedFlagState };

/**
 * Pure scheduling decision for the delayed flag. Given whether work is still
 * pending and the current visible state, returns the transition to schedule
 * (if any). Kept separate from React so the timing contract is unit-testable.
 */
export function nextDelayedFlagStep(
  active: boolean,
  state: DelayedFlagState,
  nowMs: number,
  timing: DelayedFlagTiming,
): DelayedFlagStep {
  if (active && !state.visible) {
    return {
      kind: "schedule",
      afterMs: timing.delayMs,
      next: { visible: true, shownAtMs: nowMs + timing.delayMs },
    };
  }
  if (!active && state.visible) {
    const elapsed = state.shownAtMs === null ? timing.minVisibleMs : nowMs - state.shownAtMs;
    return {
      kind: "schedule",
      afterMs: Math.max(0, timing.minVisibleMs - elapsed),
      next: { visible: false, shownAtMs: null },
    };
  }
  return { kind: "settled" };
}

/**
 * Returns `true` only after `active` has stayed true for `delayMs`, and keeps
 * returning `true` for at least `minVisibleMs` once shown. Work that finishes
 * before the delay never shows an indicator at all.
 */
export function useDelayedFlag(active: boolean, options?: Partial<DelayedFlagTiming>): boolean {
  const delayMs = options?.delayMs ?? DELAYED_FLAG_SHOW_DELAY_MS;
  const minVisibleMs = options?.minVisibleMs ?? DELAYED_FLAG_MIN_VISIBLE_MS;
  const [state, setState] = useState<DelayedFlagState>({ visible: false, shownAtMs: null });

  useEffect(() => {
    const step = nextDelayedFlagStep(active, state, Date.now(), { delayMs, minVisibleMs });
    if (step.kind === "settled") return;
    const timer = setTimeout(() => setState(step.next), step.afterMs);
    return () => clearTimeout(timer);
  }, [active, state, delayMs, minVisibleMs]);

  return state.visible;
}
