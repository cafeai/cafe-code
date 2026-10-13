import { afterEach, describe, expect, it, vi } from "vitest";
import { measureVisualizationLayout, observeVisualizationLayout } from "./visualizationLayout.ts";

function fixture() {
  let bottom = 420;
  const callbacks: (() => void)[] = [];
  const observers: { disconnect: ReturnType<typeof vi.fn> }[] = [];
  const window = new EventTarget();
  const child = { nodeType: 1, nextSibling: null, getBoundingClientRect: () => ({ bottom }) };
  const body = { firstChild: child, getBoundingClientRect: () => ({ top: 0, height: 1900 }) };
  const document = Object.assign(new EventTarget(), {
    body,
    hidden: false,
    documentElement: { dataset: { cafeVisible: "false", cafePresentationVisible: "true" } },
    defaultView: {
      getComputedStyle: () => ({
        paddingBottom: "0",
        marginBottom: "0",
        display: "block",
        position: "static",
      }),
    },
  });
  class Observer {
    disconnect = vi.fn();
    constructor(callback: () => void) {
      callbacks.push(callback);
      observers.push(this);
    }
    observe() {}
  }
  return {
    document,
    window,
    observers,
    callbacks,
    Observer,
    body,
    child,
    setBottom: (value: number) => {
      bottom = value;
    },
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("private generated natural layout", () => {
  it("measures natural child extent rather than the previous root viewport and caps oversized content", () => {
    const f = fixture();
    const measure = () => measureVisualizationLayout(f.document as unknown as Document);
    expect(measure()).toEqual({ height: 420, constrained: false });
    f.setBottom(3000);
    expect(measure()).toEqual({ height: 2000, constrained: true });
    f.setBottom(NaN);
    expect(measure()).toBeUndefined();
    f.setBottom(420);
    f.document.defaultView.getComputedStyle = () => ({
      paddingBottom: "0",
      marginBottom: "0",
      display: "block",
      position: "absolute",
    });
    expect(measure()).toEqual({ height: 80, constrained: false });
  });
  it("early-stops at a finite direct-root node count rather than allocating/scanning the subtree", () => {
    const f = fixture();
    f.child.nextSibling = f.child as never;
    expect(measureVisualizationLayout(f.document as unknown as Document)).toEqual({
      height: 2000,
      constrained: true,
    });
  });
  it("coalesces floods, refuses later hidden publication and retires exact observer/timer state", () => {
    vi.useFakeTimers();
    const f = fixture(),
      send = vi.fn();
    vi.stubGlobal("window", f.window);
    vi.stubGlobal("document", f.document);
    vi.stubGlobal("ResizeObserver", f.Observer);
    vi.stubGlobal("MutationObserver", f.Observer);
    const dispose = observeVisualizationLayout("exact-private-nonce", send);
    expect(send).toHaveBeenCalledWith({
      nonce: "exact-private-nonce",
      contextEpoch: 1,
      sequence: 1,
      height: 420,
      constrained: false,
    });
    f.document.documentElement.dataset.cafeVisible = "true";
    f.setBottom(450);
    for (let index = 0; index < 1000; index++) for (const callback of f.callbacks) callback();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(250);
    expect(send).toHaveBeenLastCalledWith({
      nonce: "exact-private-nonce",
      contextEpoch: 1,
      sequence: 2,
      height: 450,
      constrained: false,
    });
    f.setBottom(460);
    f.callbacks[0]!();
    f.document.hidden = true;
    vi.advanceTimersByTime(250);
    expect(send).toHaveBeenCalledTimes(2);
    dispose();
    dispose();
    expect(f.observers.every((observer) => observer.disconnect.mock.calls.length === 1)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("disconnects the full owned observer set after a partial observe failure", () => {
    const f = fixture(),
      send = vi.fn();
    class Failing extends f.Observer {
      override observe(): never {
        throw new Error("inert observe failure");
      }
    }
    vi.stubGlobal("window", f.window);
    vi.stubGlobal("document", f.document);
    vi.stubGlobal("ResizeObserver", Failing);
    vi.stubGlobal("MutationObserver", f.Observer);
    observeVisualizationLayout("exact-private-nonce", send);
    expect(send).not.toHaveBeenCalled();
    expect(f.observers.every((observer) => observer.disconnect.mock.calls.length === 1)).toBe(true);
  });
  it("defers positive hidden-presentation changes until exact paint resume without losing natural height", () => {
    vi.useFakeTimers();
    const f = fixture(),
      send = vi.fn();
    f.document.documentElement.dataset.cafePresentationVisible = "false";
    vi.stubGlobal("window", f.window);
    vi.stubGlobal("document", f.document);
    vi.stubGlobal("ResizeObserver", f.Observer);
    vi.stubGlobal("MutationObserver", f.Observer);
    const dispose = observeVisualizationLayout("exact-private-nonce", send);
    // The initial bounded bootstrap sample is still available while both
    // presentation states are false; later hidden work must not consume it.
    expect(send).toHaveBeenCalledOnce();
    f.document.documentElement.dataset.cafeVisible = "true";
    f.setBottom(460);
    for (const callback of f.callbacks) callback();
    f.window.dispatchEvent(new Event("cafe-visibility-changed"));
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(send).toHaveBeenCalledOnce();
    f.document.documentElement.dataset.cafePresentationVisible = "true";
    f.window.dispatchEvent(new Event("cafe-presentation-visibility-changed"));
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(250);
    expect(send).toHaveBeenLastCalledWith({
      nonce: "exact-private-nonce",
      contextEpoch: 1,
      sequence: 2,
      height: 460,
      constrained: false,
    });
    f.setBottom(470);
    f.callbacks[0]!();
    f.document.documentElement.dataset.cafePresentationVisible = "false";
    f.window.dispatchEvent(new Event("cafe-presentation-visibility-changed"));
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(250);
    expect(send).toHaveBeenCalledTimes(2);
    dispose();
    f.document.documentElement.dataset.cafePresentationVisible = "true";
    f.window.dispatchEvent(new Event("cafe-presentation-visibility-changed"));
    expect(vi.getTimerCount()).toBe(0);
  });
  it("resamples a sent-then-hidden layout on genuine paint resume without replaying duplicate true cues", () => {
    vi.useFakeTimers();
    const f = fixture(),
      send = vi.fn();
    f.document.documentElement.dataset.cafeVisible = "true";
    vi.stubGlobal("window", f.window);
    vi.stubGlobal("document", f.document);
    vi.stubGlobal("ResizeObserver", f.Observer);
    vi.stubGlobal("MutationObserver", f.Observer);
    const dispose = observeVisualizationLayout("exact-private-nonce", send);
    f.setBottom(450);
    f.callbacks[0]!();
    vi.advanceTimersByTime(250);
    expect(send).toHaveBeenLastCalledWith({
      nonce: "exact-private-nonce",
      contextEpoch: 1,
      sequence: 2,
      height: 450,
      constrained: false,
    });
    // Model the precise queued-delivery race: preload has sent/stored 450, but
    // native hides before receiving it and refuses that valid next sequence.
    // The receiving-side refusal/continuation is qualified independently below.
    f.document.documentElement.dataset.cafePresentationVisible = "false";
    f.window.dispatchEvent(new Event("cafe-presentation-visibility-changed"));
    expect(vi.getTimerCount()).toBe(0);
    f.document.documentElement.dataset.cafePresentationVisible = "true";
    f.window.dispatchEvent(new Event("cafe-presentation-visibility-changed"));
    for (let duplicate = 0; duplicate < 100; duplicate++)
      f.window.dispatchEvent(new Event("cafe-presentation-visibility-changed"));
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(250);
    expect(send).toHaveBeenLastCalledWith({
      nonce: "exact-private-nonce",
      contextEpoch: 1,
      sequence: 3,
      height: 450,
      constrained: false,
    });
    expect(send).toHaveBeenCalledTimes(3);
    for (let duplicate = 0; duplicate < 100; duplicate++)
      f.window.dispatchEvent(new Event("cafe-presentation-visibility-changed"));
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(send).toHaveBeenCalledTimes(3);
    dispose();
  });
  it("disconnects the first owned observer if the second constructor fails", () => {
    const f = fixture(),
      send = vi.fn();
    vi.stubGlobal("window", f.window);
    vi.stubGlobal("document", f.document);
    vi.stubGlobal("ResizeObserver", f.Observer);
    vi.stubGlobal(
      "MutationObserver",
      vi.fn(function failObserverConstruction() {
        throw new Error("inert constructor failure");
      }),
    );
    const dispose = observeVisualizationLayout("exact-private-nonce", send);
    dispose();
    expect(send).not.toHaveBeenCalled();
    expect(f.observers).toHaveLength(1);
    expect(f.observers[0]!.disconnect).toHaveBeenCalledOnce();
  });
  it("publishes a fresh inline context after fullscreen without forwarding fullscreen height", () => {
    vi.useFakeTimers();
    const f = fixture(),
      send = vi.fn();
    let context = { epoch: 1, inline: true };
    vi.stubGlobal("window", f.window);
    vi.stubGlobal("document", f.document);
    vi.stubGlobal("ResizeObserver", f.Observer);
    vi.stubGlobal("MutationObserver", f.Observer);
    const dispose = observeVisualizationLayout("exact-private-nonce", send, () => context);
    f.document.documentElement.dataset.cafeVisible = "true";
    context = { epoch: 2, inline: false };
    f.setBottom(1900);
    f.window.dispatchEvent(new Event("cafe-presentation-changed"));
    vi.advanceTimersByTime(250);
    expect(send).toHaveBeenCalledOnce();
    context = { epoch: 3, inline: true };
    f.setBottom(420);
    f.window.dispatchEvent(new Event("cafe-presentation-changed"));
    vi.advanceTimersByTime(250);
    expect(send).toHaveBeenLastCalledWith({
      nonce: "exact-private-nonce",
      contextEpoch: 3,
      sequence: 1,
      height: 420,
      constrained: false,
    });
    dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
