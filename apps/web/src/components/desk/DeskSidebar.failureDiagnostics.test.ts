import { describe, expect, it, vi } from "vitest";

import {
  countDeskDiagnosticCssRules,
  MAX_DESK_FAILURE_DIAGNOSTIC_LENGTH,
  rethrowWithDeskSidebarFailureDiagnostics,
  trackDeskDiagnosticPointer,
} from "./DeskSidebar.failureDiagnostics";

describe("synthetic Desk failure diagnostics", () => {
  it("counts only fixed Desk rule families without retaining selector contents", () => {
    const result = countDeskDiagnosticCssRules([
      [
        {
          type: 4,
          cssRules: [
            { type: 1, selectorText: ".group-hover\\/desk-row\\:opacity-100:hover" },
            { type: 1, selectorText: ".group-has-focus-visible\\/desk-group\\:opacity-100" },
            { type: 1, selectorText: ".synthetic-private-selector" },
          ],
        },
      ],
    ]);
    expect(result).toEqual({
      visited: 4,
      truncated: false,
      rowHover: 1,
      groupHover: 0,
      rowFocus: 0,
      groupFocus: 1,
    });
    expect(JSON.stringify(result)).not.toContain("synthetic-private-selector");
  });

  it("bounds stylesheet breadth, rule count, nesting and examined selector size", () => {
    expect(
      countDeskDiagnosticCssRules(Array.from({ length: 100 }, () => [{ type: 1 }])),
    ).toMatchObject({ visited: 16, truncated: true });
    expect(
      countDeskDiagnosticCssRules([Array.from({ length: 10_000 }, () => ({ type: 1 }))]),
    ).toMatchObject({ visited: 4_096, truncated: true });
    let nested: { type: number; cssRules?: Array<typeof nested> } = { type: 1 };
    for (let index = 0; index < 100; index++) nested = { type: 4, cssRules: [nested] };
    expect(countDeskDiagnosticCssRules([[nested]])).toMatchObject({ visited: 9, truncated: true });
    expect(
      countDeskDiagnosticCssRules([
        [{ type: 1, selectorText: "x".repeat(3_000) + "group-hover\\/desk-row" }],
      ]),
    ).toMatchObject({ rowHover: 0 });
  });

  it("reports a bounded fixed record and rethrows the exact original failure", () => {
    const error = new Error("synthetic original assertion");
    const emit = vi.fn();
    expect(() =>
      rethrowWithDeskSidebarFailureDiagnostics(
        error,
        () => ({ version: 1, available: false }),
        emit,
      ),
    ).toThrow(error);
    expect(emit).toHaveBeenCalledExactlyOnceWith('{"version":1,"available":false}');
    expect(emit.mock.calls[0]?.[0].length).toBeLessThanOrEqual(MAX_DESK_FAILURE_DIAGNOSTIC_LENGTH);
  });

  it("preserves original failure identity if observation or logging fails", () => {
    expect.assertions(2);
    const error = { exactSyntheticFailure: true };
    for (const [collect, emit] of [
      [
        () => {
          throw new Error("synthetic observation failure");
        },
        vi.fn(),
      ],
      [
        () => ({ version: 1, available: false }) as const,
        () => {
          throw new Error("synthetic logger failure");
        },
      ],
    ] as const) {
      try {
        rethrowWithDeskSidebarFailureDiagnostics(error, collect, emit);
      } catch (actual) {
        expect(actual).toBe(error);
      }
    }
  });

  it("replaces oversized output with a fixed record without truncating private text into logs", () => {
    const error = new Error("synthetic original assertion");
    const emit = vi.fn();
    expect(() =>
      rethrowWithDeskSidebarFailureDiagnostics(
        error,
        () => ({
          version: 1 as const,
          available: false as const,
          toJSON: () => ({ syntheticPrivateText: "x".repeat(20_000) }),
        }),
        emit,
      ),
    ).toThrow(error);
    expect(emit).toHaveBeenCalledExactlyOnceWith(
      '{"version":1,"available":false,"truncated":true}',
    );
  });

  it("observes pointer events passively, retains only the last bounded point and removes its listener", () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    // This synthetic document has no DOM/profile state. Only the two listener
    // methods are needed to qualify passive observation and exact cleanup.
    const pointer = trackDeskDiagnosticPointer({
      addEventListener,
      removeEventListener,
    } as unknown as Document);
    const observe = addEventListener.mock.calls[0]?.[1] as (event: PointerEvent) => void;
    for (let index = 0; index < 100; index++) {
      observe({ clientX: index, clientY: index, isTrusted: false } as PointerEvent);
    }
    observe({ clientX: 2_000_000, clientY: Number.NaN, isTrusted: true } as PointerEvent);
    expect(pointer.read()).toEqual({ count: 101, last: { x: 1_000_000, y: null, trusted: true } });
    expect(addEventListener).toHaveBeenCalledExactlyOnceWith("pointermove", observe, {
      capture: true,
      passive: true,
    });
    pointer.stop();
    expect(removeEventListener).toHaveBeenCalledExactlyOnceWith("pointermove", observe, true);
  });
});
