import { expect, it } from "vitest";
import { stepCountUp } from "./countUpValue";
it.each([
  [0, 1000],
  [1000, 0],
  [10.01, 10.02],
])("approaches %s → %s without overshooting and eventually settles", (from, target) => {
  let current = from;
  for (let i = 0; i < 20; i++) {
    const next = stepCountUp(current, target, 1000, 0.01, 220);
    expect(next.value).toBeGreaterThanOrEqual(Math.min(current, target));
    expect(next.value).toBeLessThanOrEqual(Math.max(current, target));
    current = next.value;
  }
  expect(current).toBe(target);
});
it("does not move backward when a monotonic clock supplies an earlier frame", () => {
  expect(stepCountUp(0, 100, -1, 1, 220).value).toBe(0);
});
it("settles sub-quantum differences to the exact target", () => {
  expect(stepCountUp(1, 1.001, 16, 0.01, 220)).toEqual({ value: 1.001, done: true });
});
