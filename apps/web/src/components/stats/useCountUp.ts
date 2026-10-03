import { useEffect, useRef, useState, useSyncExternalStore } from "react";

type CountUpFrameListener = (now: number) => boolean;

const countUpFrameListeners = new Set<CountUpFrameListener>();
let countUpFrameId: number | null = null;

function runCountUpFrame(now: number): void {
  countUpFrameId = null;
  for (const listener of [...countUpFrameListeners]) {
    // React cleanup can remove another listener while this snapshot is being
    // visited. Never update an unmounted counter from that stale callback.
    if (!countUpFrameListeners.has(listener)) continue;
    if (!listener(now)) countUpFrameListeners.delete(listener);
  }
  scheduleCountUpFrame();
}

function scheduleCountUpFrame(): void {
  if (countUpFrameId !== null || countUpFrameListeners.size === 0) return;
  countUpFrameId = window.requestAnimationFrame(runCountUpFrame);
}

/**
 * Every count-up on the page shares one animation-frame source. Model tables
 * can contain many independently changing values; a single browser frame loop
 * keeps them synchronized without allocating one timer per row.
 */
function subscribeCountUpFrame(listener: CountUpFrameListener): () => void {
  countUpFrameListeners.add(listener);
  scheduleCountUpFrame();
  return () => {
    countUpFrameListeners.delete(listener);
    if (countUpFrameListeners.size === 0 && countUpFrameId !== null) {
      window.cancelAnimationFrame(countUpFrameId);
      countUpFrameId = null;
    }
  };
}

const reducedMotionListeners = new Set<() => void>();
let reducedMotionQuery: MediaQueryList | null = null;

function getReducedMotionQuery(): MediaQueryList | null {
  if (typeof window === "undefined") return null;
  reducedMotionQuery ??= window.matchMedia("(prefers-reduced-motion: reduce)");
  return reducedMotionQuery;
}

function readPrefersReducedMotion(): boolean {
  return getReducedMotionQuery()?.matches ?? false;
}

function emitReducedMotionChange(): void {
  for (const listener of reducedMotionListeners) listener();
}

function subscribeReducedMotion(listener: () => void): () => void {
  const query = getReducedMotionQuery();
  if (query === null) return () => undefined;
  if (reducedMotionListeners.size === 0) {
    query.addEventListener("change", emitReducedMotionChange);
  }
  reducedMotionListeners.add(listener);
  return () => {
    reducedMotionListeners.delete(listener);
    if (reducedMotionListeners.size === 0) {
      query.removeEventListener("change", emitReducedMotionChange);
      // Tests and embedded browser surfaces can replace matchMedia between
      // complete mounts. Reacquire it for the next subscriber rather than
      // retaining a detached query object forever.
      reducedMotionQuery = null;
    }
  };
}

function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, readPrefersReducedMotion, () => false);
}

/**
 * Smoothly animates a displayed integer toward `target`, counting *through* the
 * intermediate values so a large jump — e.g. a provider that reports a whole
 * turn's tokens at once — races upward instead of snapping. Uses an exponential
 * approach so the ~10Hz live snapshots retarget smoothly and settle without a
 * permanent animation loop, and snaps immediately under prefers-reduced-motion.
 *
 * `timeConstantMs` is the exponential time constant; the value covers ~95% of
 * any gap in ~3× that (so ~660ms by default), independent of jump size.
 *
 * `decimals` sets the settle precision. Token counts are whole numbers and
 * animate at 0; currency needs 2 so a dollar figure does not appear to freeze
 * while cents are still moving, and so it settles on an exact value rather than
 * a rounded one.
 */
export function useCountUp(
  target: number,
  { timeConstantMs = 220, decimals = 0 }: { timeConstantMs?: number; decimals?: number } = {},
): number {
  const reduced = usePrefersReducedMotion();
  const displayRef = useRef(target);
  const [display, setDisplay] = useState(target);

  useEffect(() => {
    // Derived inside the effect: `decimals` is the real dependency, and
    // deriving these outside would re-arm the effect on every render.
    const quantum = 10 ** -decimals;
    const quantize = (value: number) => Math.round(value / quantum) * quantum;

    if (reduced) {
      displayRef.current = target;
      setDisplay(target);
      return;
    }
    if (quantize(displayRef.current) === quantize(target)) {
      displayRef.current = target;
      return;
    }

    let last = performance.now();
    const step = (now: number): boolean => {
      const dt = Math.min(64, now - last);
      last = now;
      const diff = target - displayRef.current;
      if (Math.abs(diff) < quantum / 2) {
        displayRef.current = target;
        setDisplay(quantize(target));
        return false;
      }
      displayRef.current += diff * (1 - Math.exp(-dt / timeConstantMs));
      setDisplay(quantize(displayRef.current));
      return true;
    };

    return subscribeCountUpFrame(step);
  }, [target, reduced, timeConstantMs, decimals]);

  return display;
}
