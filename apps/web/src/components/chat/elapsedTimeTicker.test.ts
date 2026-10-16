import { afterEach, expect, it, vi } from "vitest";
import { startElapsedTimeTicker } from "./elapsedTimeTicker";
afterEach(() => vi.useRealTimers());
function visibility() {
  const listeners = new Set<() => void>();
  return {
    visibilityState: "visible",
    addEventListener: (_type: string, listener: () => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: () => void) => {
      listeners.delete(listener);
    },
    change(state: string) {
      this.visibilityState = state;
      for (const l of listeners) l();
    },
    listeners,
  };
}
it("counts from the original turn edge, pauses hidden work, catches up and retires", () => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  const document = visibility(),
    publish = vi.fn();
  const dispose = startElapsedTimeTicker({ startedMs: 5000, publish, visibility: document });
  expect(publish).toHaveBeenLastCalledWith(5000);
  vi.advanceTimersByTime(1000);
  expect(publish).toHaveBeenLastCalledWith(6000);
  document.change("hidden");
  const count = publish.mock.calls.length;
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(5000);
  expect(publish).toHaveBeenCalledTimes(count);
  document.change("visible");
  expect(publish).toHaveBeenLastCalledWith(11000);
  dispose();
  dispose();
  vi.advanceTimersByTime(1000);
  expect(document.listeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
it("clamps future timestamps and never lets a disposed owner update a replacement", () => {
  vi.useFakeTimers();
  vi.setSystemTime(10000);
  const document = visibility(),
    first = vi.fn(),
    second = vi.fn();
  const stop = startElapsedTimeTicker({ startedMs: 12000, publish: first, visibility: document });
  expect(first).toHaveBeenLastCalledWith(0);
  stop();
  const stopNext = startElapsedTimeTicker({
    startedMs: 10000,
    publish: second,
    visibility: document,
  });
  vi.advanceTimersByTime(1000);
  expect(first).toHaveBeenCalledOnce();
  expect(second).toHaveBeenLastCalledWith(1000);
  stopNext();
});
