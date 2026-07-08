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
 */
export function useCountUp(target: number, timeConstantMs = 220): number {
  const reduced = usePrefersReducedMotion();
  const displayRef = useRef(target);
  const [display, setDisplay] = useState(target);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (reduced) {
      displayRef.current = target;
      setDisplay(target);
      return;
    }
    if (Math.round(displayRef.current) === Math.round(target)) {
      displayRef.current = target;
      return;
    }

    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(64, now - last);
      last = now;
      const diff = target - displayRef.current;
      if (Math.abs(diff) < 0.5) {
        displayRef.current = target;
        setDisplay(Math.round(target));
        rafRef.current = null;
        return;
      }
      displayRef.current += diff * (1 - Math.exp(-dt / timeConstantMs));
      setDisplay(Math.round(displayRef.current));
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
  }, [target, reduced, timeConstantMs]);

  return display;
}
