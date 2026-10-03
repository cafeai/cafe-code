import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useCountUp } from "./useCountUp";

interface CounterTarget {
  readonly id: string;
  readonly value: number;
  readonly decimals?: number;
}

function Counter({ id, value, decimals = 0 }: CounterTarget) {
  const displayed = useCountUp(value, { decimals });
  return <output data-counter={id}>{displayed.toFixed(decimals)}</output>;
}

function Counters({ targets }: { readonly targets: readonly CounterTarget[] }) {
  return targets.map((target) => <Counter key={target.id} {...target} />);
}

function displayedValue(id: string): number {
  const output = document.querySelector(`[data-counter="${id}"]`);
  expect(output).not.toBeNull();
  return Number(output?.textContent);
}

describe("useCountUp frame timing", () => {
  let screen: Awaited<ReturnType<typeof render>> | undefined;
  let now: number;
  let nextFrameId: number;
  let pendingFrames: Map<number, FrameRequestCallback>;
  let reducedMotion: boolean;

  beforeEach(() => {
    now = 10_000;
    nextFrameId = 1;
    pendingFrames = new Map();
    reducedMotion = false;
    // Own only the hook's monotonic animation clock. No wall-clock waits or
    // global fake timers are needed to qualify frame throttling and cleanup.
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const id = nextFrameId++;
      pendingFrames.set(id, callback);
      return id;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      pendingFrames.delete(id);
    });
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    vi.spyOn(query, "matches", "get").mockImplementation(() => reducedMotion);
    vi.spyOn(window, "matchMedia").mockReturnValue(query);
  });

  afterEach(async () => {
    await screen?.unmount();
    screen = undefined;
    // Every test must retire its subscription before browser APIs are restored;
    // otherwise one leaked global listener could affect later usage counters.
    expect(pendingFrames.size).toBe(0);
    vi.restoreAllMocks();
  });

  async function frameAt(timestamp: number): Promise<void> {
    now = timestamp;
    const callbacks = [...pendingFrames.entries()];
    expect(callbacks).toHaveLength(1);
    await act(() => {
      for (const [id, callback] of callbacks) {
        pendingFrames.delete(id);
        callback(timestamp);
      }
    });
  }

  async function frameAfter(elapsedMs: number): Promise<void> {
    await frameAt(now + elapsedMs);
  }

  it("makes the same progress after dense and sparse frames with equal elapsed time", async () => {
    async function sample(frameDurations: readonly number[]): Promise<number> {
      screen = await render(<Counters targets={[{ id: "tokens", value: 0 }]} />);
      await screen.rerender(<Counters targets={[{ id: "tokens", value: 1_000_000 }]} />);
      for (const elapsedMs of frameDurations) await frameAfter(elapsedMs);
      const value = displayedValue("tokens");
      await screen.unmount();
      screen = undefined;
      expect(pendingFrames.size).toBe(0);
      return value;
    }

    const dense = await sample(Array.from({ length: 20 }, () => 16));
    const sparse = await sample([320]);
    expect(dense).toBeGreaterThan(0);
    expect(dense).toBeLessThan(1_000_000);
    expect(sparse).toBe(dense);
    expect(sparse).toBe(Math.round(1_000_000 * (1 - Math.exp(-320 / 220))));
  });

  it("catches up to exact token and USD totals after a long frame pause, then stops", async () => {
    screen = await render(
      <Counters
        targets={[
          { id: "tokens", value: 3_000_000 },
          { id: "usd", value: 9_000.12, decimals: 2 },
        ]}
      />,
    );
    await screen.rerender(
      <Counters
        targets={[
          { id: "tokens", value: 4_800_000 },
          { id: "usd", value: 24_028.67, decimals: 2 },
        ]}
      />,
    );
    // Two independent values share exactly one frame source, including the
    // first ordinary intermediate frame and the delayed resumed frame.
    expect(pendingFrames.size).toBe(1);
    await frameAfter(16);
    expect(displayedValue("tokens")).toBeGreaterThan(3_000_000);
    expect(displayedValue("tokens")).toBeLessThan(4_800_000);
    expect(displayedValue("usd")).toBeGreaterThan(9_000.12);
    expect(displayedValue("usd")).toBeLessThan(24_028.67);

    await frameAfter(5_000);
    expect(displayedValue("tokens")).toBe(4_800_000);
    expect(document.querySelector('[data-counter="usd"]')?.textContent).toBe("24028.67");
    await frameAfter(16);
    expect(pendingFrames.size).toBe(0);
  });

  it("retargets downward from its displayed progress without overshooting either target", async () => {
    screen = await render(<Counters targets={[{ id: "tokens", value: 0 }]} />);
    await screen.rerender(<Counters targets={[{ id: "tokens", value: 1_000 }]} />);
    await frameAfter(220);
    const turningPoint = displayedValue("tokens");
    expect(turningPoint).toBeGreaterThan(100);
    expect(turningPoint).toBeLessThan(1_000);

    await screen.rerender(<Counters targets={[{ id: "tokens", value: 100 }]} />);
    expect(displayedValue("tokens")).toBe(turningPoint);
    let previous = turningPoint;
    for (const elapsedMs of [16, 80, 220, 5_000]) {
      await frameAfter(elapsedMs);
      const current = displayedValue("tokens");
      expect(current).toBeLessThanOrEqual(previous);
      expect(current).toBeGreaterThanOrEqual(100);
      previous = current;
    }
    expect(previous).toBe(100);
    await frameAfter(16);
    expect(pendingFrames.size).toBe(0);
  });

  it("does not move away from the target when the first frame timestamp precedes subscription", async () => {
    screen = await render(<Counters targets={[{ id: "tokens", value: 0 }]} />);
    await screen.rerender(<Counters targets={[{ id: "tokens", value: 1_000 }]} />);
    // A RAF timestamp names the frame start, which can precede an effect that
    // subscribed during the same frame. Such a sample must not integrate back.
    await frameAt(9_999);
    expect(displayedValue("tokens")).toBe(0);
    await frameAfter(16);
    expect(displayedValue("tokens")).toBeGreaterThan(0);
    expect(displayedValue("tokens")).toBeLessThan(1_000);
  });

  it("keeps the shared frame for surviving counters and cancels it after the last unmount", async () => {
    screen = await render(
      <Counters
        targets={[
          { id: "first", value: 0 },
          { id: "second", value: 0 },
        ]}
      />,
    );
    await screen.rerender(
      <Counters
        targets={[
          { id: "first", value: 1_000 },
          { id: "second", value: 2_000 },
        ]}
      />,
    );
    expect(pendingFrames.size).toBe(1);
    await frameAfter(16);
    const previous = displayedValue("second");
    const cancellationCount = vi.mocked(window.cancelAnimationFrame).mock.calls.length;

    await screen.rerender(<Counters targets={[{ id: "second", value: 2_000 }]} />);
    expect(document.querySelector('[data-counter="first"]')).toBeNull();
    expect(vi.mocked(window.cancelAnimationFrame).mock.calls).toHaveLength(cancellationCount);
    await frameAfter(16);
    expect(displayedValue("second")).toBeGreaterThan(previous);
    const pendingId = pendingFrames.keys().next().value;

    await screen.unmount();
    screen = undefined;
    expect(window.cancelAnimationFrame).toHaveBeenLastCalledWith(pendingId);
    expect(pendingFrames.size).toBe(0);
  });

  it("snaps under reduced motion without subscribing to animation frames", async () => {
    reducedMotion = true;
    screen = await render(<Counters targets={[{ id: "tokens", value: 0 }]} />);
    await screen.rerender(<Counters targets={[{ id: "tokens", value: 4_800_000 }]} />);
    expect(displayedValue("tokens")).toBe(4_800_000);
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
    expect(pendingFrames.size).toBe(0);
  });
});
