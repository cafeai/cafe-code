import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  getViewportArrowScrollTarget,
  getViewportEndScrollTarget,
  isFocusedViewportArrowKey,
  scrollViewportOnArrowKey,
  scrollViewportOnEndKey,
} from "./viewportKeyboardScroll";

const geometry = {
  scrollLeft: 80,
  scrollTop: 70,
  scrollWidth: 300,
  scrollHeight: 220,
  clientWidth: 100,
  clientHeight: 100,
  direction: "ltr" as const,
};

/**
 * A fresh, synchronous DOM boundary for controller policy. Actual React event
 * propagation, native selection and viewer wiring are covered by browser tests;
 * this fixture controls whether the native offset write really takes effect.
 */
function fixture() {
  const order: string[] = [];
  const document = {
    activeElement: null as unknown,
    defaultView: {
      getComputedStyle: vi.fn(() => ({ direction: "ltr" })),
    } as { getComputedStyle: () => { direction: string } } | null,
    getSelection: vi.fn<() => Pick<Selection, "isCollapsed"> | null>(() => ({
      isCollapsed: true,
    })),
  };
  const viewport = {
    ...geometry,
    isConnected: true,
    isContentEditable: false,
    ownerDocument: document,
    closest: vi.fn<() => Element | null>(() => null),
    scrollTo: vi.fn((options: ScrollToOptions) => {
      order.push("scroll");
      if (options.left !== undefined) viewport.scrollLeft = options.left;
      if (options.top !== undefined) viewport.scrollTop = options.top;
    }),
  };
  document.activeElement = viewport;
  const input = {
    key: "ArrowRight",
    target: viewport as unknown,
    currentTarget: viewport,
    cancelable: true,
    defaultPrevented: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    nativeEvent: { defaultPrevented: false, isComposing: false, keyCode: 39 },
    preventDefault: vi.fn(() => {
      order.push("prevent");
      input.defaultPrevented = true;
    }),
    stopPropagation: vi.fn(() => order.push("stop")),
  };
  const event = input as unknown as ReactKeyboardEvent<HTMLElement>;
  return { viewport, document, input, event, order };
}

function endFixture() {
  const value = fixture();
  value.input.key = "End";
  value.input.nativeEvent.keyCode = 35;
  return value;
}

describe("viewport arrow target", () => {
  it.each([
    ["ArrowLeft", { left: 40, top: 70 }],
    ["ArrowRight", { left: 120, top: 70 }],
    ["ArrowUp", { left: 80, top: 30 }],
    ["ArrowDown", { left: 80, top: 110 }],
  ] as const)("moves one physical line for %s without changing the other axis", (key, target) => {
    expect(getViewportArrowScrollTarget(key, geometry)).toEqual(target);
  });

  it.each([
    ["ArrowLeft", { scrollLeft: 3 }, { left: 0, top: 70 }],
    ["ArrowRight", { scrollLeft: 198 }, { left: 200, top: 70 }],
    ["ArrowUp", { scrollTop: 2 }, { left: 80, top: 0 }],
    ["ArrowDown", { scrollTop: 119 }, { left: 80, top: 120 }],
  ] as const)("clamps %s to the actual scroll boundary", (key, position, target) => {
    expect(getViewportArrowScrollTarget(key, { ...geometry, ...position })).toEqual(target);
  });

  it("keeps physical directions in the native negative RTL interval", () => {
    const rtl = { ...geometry, direction: "rtl" as const, scrollLeft: -80 };
    expect(getViewportArrowScrollTarget("ArrowLeft", rtl)).toEqual({ left: -120, top: 70 });
    expect(getViewportArrowScrollTarget("ArrowRight", rtl)).toEqual({ left: -40, top: 70 });
    expect(getViewportArrowScrollTarget("ArrowDown", rtl)).toEqual({ left: -80, top: 110 });
    expect(getViewportArrowScrollTarget("ArrowLeft", { ...rtl, scrollLeft: -198 })).toEqual({
      left: -200,
      top: 70,
    });
    expect(getViewportArrowScrollTarget("ArrowRight", { ...rtl, scrollLeft: -3 })).toEqual({
      left: 0,
      top: 70,
    });
    expect(getViewportArrowScrollTarget("ArrowLeft", { ...rtl, scrollLeft: -200 })).toBeUndefined();
    expect(getViewportArrowScrollTarget("ArrowRight", { ...rtl, scrollLeft: 0 })).toBeUndefined();
  });

  it.each([
    ["ArrowLeft", { scrollLeft: 0 }],
    ["ArrowRight", { scrollLeft: 200 }],
    ["ArrowUp", { scrollTop: 0 }],
    ["ArrowDown", { scrollTop: 120 }],
    ["ArrowRight", { scrollWidth: 100, scrollLeft: 0 }],
    ["ArrowDown", { scrollHeight: 100, scrollTop: 0 }],
    ["ArrowLeft", { scrollLeft: -1 }],
    ["ArrowRight", { scrollLeft: 201 }],
    ["ArrowUp", { scrollTop: -1 }],
    ["ArrowDown", { scrollTop: 121 }],
    ["ArrowRight", { scrollTop: -1 }],
    ["ArrowRight", { scrollTop: 121 }],
    ["ArrowDown", { scrollLeft: -1 }],
    ["ArrowDown", { scrollLeft: 201 }],
  ] as const)("leaves %s unhandled without an in-range movement", (key, position) => {
    expect(getViewportArrowScrollTarget(key, { ...geometry, ...position })).toBeUndefined();
  });

  it.each(["Home", "End", "PageUp", "PageDown", "Escape", " ", "+", "0"])(
    "does not replace the native %s command",
    (key) => expect(getViewportArrowScrollTarget(key, geometry)).toBeUndefined(),
  );

  it.each([
    { scrollLeft: NaN },
    { scrollTop: Infinity },
    { scrollWidth: -1 },
    { scrollHeight: -1 },
    { clientWidth: 0 },
    { clientHeight: 0 },
  ])("refuses nonfinite or unmeasurable geometry %j", (changed) => {
    expect(getViewportArrowScrollTarget("ArrowRight", { ...geometry, ...changed })).toBeUndefined();
  });
});

describe("focused viewport arrow ownership", () => {
  const refusals: ReadonlyArray<readonly [string, (value: ReturnType<typeof fixture>) => void]> = [
    [
      "a descendant target",
      ({ input }) => {
        input.target = {};
      },
    ],
    [
      "a different focused element",
      ({ document }) => {
        document.activeElement = {};
      },
    ],
    [
      "no focused element",
      ({ document }) => {
        document.activeElement = null;
      },
    ],
    [
      "a disconnected viewport",
      ({ viewport }) => {
        viewport.isConnected = false;
      },
    ],
    [
      "editable content",
      ({ viewport }) => {
        viewport.isContentEditable = true;
      },
    ],
    [
      "an inert or hidden ancestor",
      ({ viewport }) => {
        viewport.closest.mockReturnValue({} as Element);
      },
    ],
    [
      "selected text",
      ({ document }) => {
        document.getSelection.mockReturnValue({ isCollapsed: false });
      },
    ],
    [
      "React prevention",
      ({ input }) => {
        input.defaultPrevented = true;
      },
    ],
    [
      "native prevention",
      ({ input }) => {
        input.nativeEvent.defaultPrevented = true;
      },
    ],
    [
      "a noncancelable event",
      ({ input }) => {
        input.cancelable = false;
      },
    ],
    [
      "Alt",
      ({ input }) => {
        input.altKey = true;
      },
    ],
    [
      "Control",
      ({ input }) => {
        input.ctrlKey = true;
      },
    ],
    [
      "Meta",
      ({ input }) => {
        input.metaKey = true;
      },
    ],
    [
      "Shift",
      ({ input }) => {
        input.shiftKey = true;
      },
    ],
    [
      "composition",
      ({ input }) => {
        input.nativeEvent.isComposing = true;
      },
    ],
    [
      "legacy composition code",
      ({ input }) => {
        input.nativeEvent.keyCode = 229;
      },
    ],
    [
      "a non-arrow command",
      ({ input }) => {
        input.key = "Home";
      },
    ],
  ];
  it.each(refusals)("preserves %s without a write or interception", (_name, change) => {
    const value = fixture();
    change(value);
    expect(isFocusedViewportArrowKey(value.event)).toBe(false);
    expect(scrollViewportOnArrowKey(value.event)).toBe(false);
    expect(value.viewport.scrollTo).not.toHaveBeenCalled();
    expect(value.input.preventDefault).not.toHaveBeenCalled();
    expect(value.input.stopPropagation).not.toHaveBeenCalled();
    expect([value.viewport.scrollLeft, value.viewport.scrollTop]).toEqual([80, 70]);

    // End has the same ownership boundary, without widening the arrow API or
    // borrowing an arrow event to satisfy an otherwise ineligible command.
    const end = endFixture();
    change(end);
    expect(scrollViewportOnEndKey(end.event)).toBe(false);
    expect(end.viewport.scrollTo).not.toHaveBeenCalled();
    expect(end.input.preventDefault).not.toHaveBeenCalled();
    expect(end.input.stopPropagation).not.toHaveBeenCalled();
    expect([end.viewport.scrollLeft, end.viewport.scrollTop]).toEqual([80, 70]);
  });

  it("consumes only after the exact native instant offset has changed", () => {
    const value = fixture();
    expect(isFocusedViewportArrowKey(value.event)).toBe(true);
    expect(scrollViewportOnArrowKey(value.event)).toBe(true);
    expect(value.viewport.scrollTo).toHaveBeenCalledExactlyOnceWith({
      left: 120,
      top: 70,
      behavior: "instant",
    });
    expect([value.viewport.scrollLeft, value.viewport.scrollTop]).toEqual([120, 70]);
    expect(value.order).toEqual(["scroll", "prevent", "stop"]);
    expect(value.input.preventDefault).toHaveBeenCalledOnce();
    expect(value.input.stopPropagation).toHaveBeenCalledOnce();
  });

  it("leaves native handling available when a native write does not move", () => {
    const value = fixture();
    value.viewport.scrollTo.mockImplementation(() => undefined);
    expect(scrollViewportOnArrowKey(value.event)).toBe(false);
    expect(value.viewport.scrollTo).toHaveBeenCalledOnce();
    expect(value.input.preventDefault).not.toHaveBeenCalled();
    expect(value.input.stopPropagation).not.toHaveBeenCalled();
  });

  it("does not consume a write that only clamps the other axis or moves backwards", () => {
    for (const write of [
      (viewport: ReturnType<typeof fixture>["viewport"]) => {
        viewport.scrollTop = 0;
      },
      (viewport: ReturnType<typeof fixture>["viewport"]) => {
        viewport.scrollLeft = 79;
      },
    ]) {
      const value = fixture();
      value.viewport.scrollTo.mockImplementation(() => write(value.viewport));
      expect(scrollViewportOnArrowKey(value.event)).toBe(false);
      expect(value.input.preventDefault).not.toHaveBeenCalled();
      expect(value.input.stopPropagation).not.toHaveBeenCalled();
    }
    const elastic = fixture();
    elastic.viewport.scrollTop = -1;
    expect(scrollViewportOnArrowKey(elastic.event)).toBe(false);
    expect(elastic.viewport.scrollTo).not.toHaveBeenCalled();
    expect(elastic.input.preventDefault).not.toHaveBeenCalled();
  });

  it("distinguishes eligible image-boundary keys from consumed movement", () => {
    const value = fixture();
    value.viewport.scrollLeft = 200;
    expect(isFocusedViewportArrowKey(value.event)).toBe(true);
    expect(scrollViewportOnArrowKey(value.event)).toBe(false);
    expect(value.viewport.scrollTo).not.toHaveBeenCalled();
    expect(value.input.preventDefault).not.toHaveBeenCalled();
    expect(value.input.stopPropagation).not.toHaveBeenCalled();
  });

  it("uses the owning document's direction and leaves a missing view unhandled", () => {
    const value = fixture();
    value.viewport.scrollLeft = -80;
    value.document.defaultView = { getComputedStyle: () => ({ direction: "rtl" }) };
    expect(scrollViewportOnArrowKey(value.event)).toBe(true);
    expect(value.viewport.scrollTo).toHaveBeenCalledExactlyOnceWith({
      left: -40,
      top: 70,
      behavior: "instant",
    });
    const missing = fixture();
    missing.document.defaultView = null;
    expect(scrollViewportOnArrowKey(missing.event)).toBe(false);
    expect(missing.viewport.scrollTo).not.toHaveBeenCalled();
    expect(missing.input.preventDefault).not.toHaveBeenCalled();
    const unknownDirection = fixture();
    unknownDirection.document.defaultView = { getComputedStyle: () => ({ direction: "unknown" }) };
    expect(scrollViewportOnArrowKey(unknownDirection.event)).toBe(false);
    expect(unknownDirection.viewport.scrollTo).not.toHaveBeenCalled();
    expect(unknownDirection.input.preventDefault).not.toHaveBeenCalled();
  });
});

describe("viewport End target", () => {
  it("targets the actual vertical end while preserving either native horizontal direction", () => {
    expect(getViewportEndScrollTarget(geometry)).toEqual({ left: 80, top: 120 });
    expect(getViewportEndScrollTarget({ ...geometry, scrollTop: 0 })).toEqual({
      left: 80,
      top: 120,
    });
    expect(getViewportEndScrollTarget({ ...geometry, scrollTop: 119.5 })).toEqual({
      left: 80,
      top: 120,
    });
    expect(getViewportEndScrollTarget({ ...geometry, direction: "rtl", scrollLeft: -80 })).toEqual({
      left: -80,
      top: 120,
    });
  });

  it.each([
    { scrollTop: 120 },
    { scrollHeight: 100, scrollTop: 0 },
    { scrollHeight: 99, scrollTop: 0 },
    { scrollLeft: -1 },
    { scrollLeft: 201 },
    { scrollTop: -1 },
    { scrollTop: 121 },
    { direction: "rtl" as const, scrollLeft: -201 },
    { direction: "rtl" as const, scrollLeft: 1 },
  ])("refuses a boundary, absent vertical overflow or elastic axis %j", (changed) => {
    expect(getViewportEndScrollTarget({ ...geometry, ...changed })).toBeUndefined();
  });

  it.each([
    { scrollLeft: NaN },
    { scrollTop: Infinity },
    { scrollWidth: Infinity },
    { scrollHeight: NaN },
    { clientWidth: Infinity },
    { clientHeight: NaN },
    { scrollWidth: -1 },
    { scrollHeight: -1 },
    { clientWidth: 0 },
    { clientHeight: 0 },
  ])("refuses nonfinite or unmeasurable End geometry %j", (changed) => {
    expect(getViewportEndScrollTarget({ ...geometry, ...changed })).toBeUndefined();
  });
});

describe("focused viewport End ownership", () => {
  it.each([
    "Home",
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
    "PageUp",
    "PageDown",
    "Escape",
  ])("does not acquire the separate native %s command", (key) => {
    const value = endFixture();
    value.input.key = key;
    expect(scrollViewportOnEndKey(value.event)).toBe(false);
    expect(value.viewport.scrollTo).not.toHaveBeenCalled();
    expect(value.input.preventDefault).not.toHaveBeenCalled();
    expect(value.input.stopPropagation).not.toHaveBeenCalled();
  });

  it("consumes End only after the exact native vertical offset changes", () => {
    const value = endFixture();
    expect(scrollViewportOnEndKey(value.event)).toBe(true);
    expect(value.viewport.scrollTo).toHaveBeenCalledExactlyOnceWith({
      left: 80,
      top: 120,
      behavior: "instant",
    });
    expect([value.viewport.scrollLeft, value.viewport.scrollTop]).toEqual([80, 120]);
    expect(value.order).toEqual(["scroll", "prevent", "stop"]);
    expect(value.input.preventDefault).toHaveBeenCalledOnce();
    expect(value.input.stopPropagation).toHaveBeenCalledOnce();
  });

  it("does not consume a no-op, horizontal-only, backwards or nonfinite native write", () => {
    for (const write of [
      () => undefined,
      (viewport: ReturnType<typeof fixture>["viewport"]) => {
        viewport.scrollLeft = 0;
      },
      (viewport: ReturnType<typeof fixture>["viewport"]) => {
        viewport.scrollTop = 69;
      },
      (viewport: ReturnType<typeof fixture>["viewport"]) => {
        viewport.scrollTop = NaN;
      },
    ]) {
      const value = endFixture();
      value.viewport.scrollTo.mockImplementation(() => write(value.viewport));
      expect(scrollViewportOnEndKey(value.event)).toBe(false);
      expect(value.viewport.scrollTo).toHaveBeenCalledExactlyOnceWith({
        left: 80,
        top: 120,
        behavior: "instant",
      });
      expect(value.input.preventDefault).not.toHaveBeenCalled();
      expect(value.input.stopPropagation).not.toHaveBeenCalled();
    }
  });

  it("does not write at the end, without vertical overflow or during other-axis elasticity", () => {
    for (const position of [
      { scrollTop: 120 },
      { scrollHeight: 100, scrollTop: 0 },
      { scrollLeft: 201 },
    ]) {
      const value = endFixture();
      Object.assign(value.viewport, position);
      expect(scrollViewportOnEndKey(value.event)).toBe(false);
      expect(value.viewport.scrollTo).not.toHaveBeenCalled();
      expect(value.input.preventDefault).not.toHaveBeenCalled();
      expect(value.input.stopPropagation).not.toHaveBeenCalled();
    }
  });

  it("uses the owning document's RTL direction and refuses a missing or unknown view", () => {
    const value = endFixture();
    value.viewport.scrollLeft = -80;
    value.document.defaultView = { getComputedStyle: () => ({ direction: "rtl" }) };
    expect(scrollViewportOnEndKey(value.event)).toBe(true);
    expect(value.viewport.scrollTo).toHaveBeenCalledExactlyOnceWith({
      left: -80,
      top: 120,
      behavior: "instant",
    });
    const missing = endFixture();
    missing.document.defaultView = null;
    expect(scrollViewportOnEndKey(missing.event)).toBe(false);
    expect(missing.viewport.scrollTo).not.toHaveBeenCalled();
    expect(missing.input.preventDefault).not.toHaveBeenCalled();
    const unknownDirection = endFixture();
    unknownDirection.document.defaultView = { getComputedStyle: () => ({ direction: "unknown" }) };
    expect(scrollViewportOnEndKey(unknownDirection.event)).toBe(false);
    expect(unknownDirection.viewport.scrollTo).not.toHaveBeenCalled();
    expect(unknownDirection.input.preventDefault).not.toHaveBeenCalled();
  });
});
