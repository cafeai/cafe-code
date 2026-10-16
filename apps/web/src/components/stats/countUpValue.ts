/** Numerical display step only. Clock/RAF and React ownership remain in the hook. */
export function stepCountUp(
  current: number,
  target: number,
  elapsedMs: number,
  quantum: number,
  timeConstantMs: number,
): { value: number; done: boolean } {
  if (Math.abs(target - current) < quantum / 2) return { value: target, done: true };
  return {
    value: current + (target - current) * (1 - Math.exp(-Math.max(0, elapsedMs) / timeConstantMs)),
    done: false,
  };
}
