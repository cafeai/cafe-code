import { useEffect, useRef, useState } from "react";

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
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
  const rafRef = useRef<number | null>(null);

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
    const step = (now: number) => {
      const dt = Math.min(64, now - last);
      last = now;
      const diff = target - displayRef.current;
      if (Math.abs(diff) < quantum / 2) {
        displayRef.current = target;
        setDisplay(quantize(target));
        rafRef.current = null;
        return;
      }
      displayRef.current += diff * (1 - Math.exp(-dt / timeConstantMs));
      setDisplay(quantize(displayRef.current));
      rafRef.current = requestAnimationFrame(step);
    };

    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
    }
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [target, reduced, timeConstantMs, decimals]);

  return display;
}
