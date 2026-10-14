import "../../index.css";

import { EnvironmentId, MessageId, ProviderDriverKind, TurnId } from "@cafecode/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef, type ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { cdp, page } from "vitest/browser";
import { render } from "vitest-browser-react";

// Retain the original two-row fixture's rendering boundary. This case qualifies
// action layout, not virtualizer scrolling, which has its own real-list suite.
// No shared desktop page receives CDP device or touch mutations: the browser
// project initializes and disposes this native mobile/touch context itself.
vi.mock("@legendapp/list/react", () => ({
  LegendList: (props: {
    data: Array<{ id: string }>;
    keyExtractor: (item: { id: string }) => string;
    renderItem: (args: { item: { id: string } }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
  }) => (
    <div data-testid="legend-list">
      {props.ListHeaderComponent}
      {props.data.map((item) => (
        <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
      ))}
      {props.ListFooterComponent}
    </div>
  ),
}));

import { MessagesTimeline } from "./MessagesTimeline";
import { ScrollToBottomControl } from "./ScrollToBottomControl";

it("keeps message actions visible and inside the normal layout on touch screens", async () => {
  // These are observed native media values, never matchMedia stubs or CSS
  // overrides. An accidentally desktop-bound run must fail before rendering.
  expect(window.matchMedia("(hover: none)").matches).toBe(true);
  expect(window.matchMedia("(pointer: coarse)").matches).toBe(true);
  expect(window.matchMedia("(hover: hover)").matches).toBe(false);
  expect(navigator.maxTouchPoints).toBeGreaterThan(0);
  expect(window.innerWidth).toBe(430);
  expect(window.innerHeight).toBe(932);

  const createdAt = "2026-04-13T12:00:00.000Z";
  const view = await render(
    <div className="bg-background text-foreground" style={{ width: "100%", height: 540 }}>
      <MessagesTimeline
        activeThreadEnvironmentId={EnvironmentId.make("environment-local")}
        activeProvider={ProviderDriverKind.make("claudeAgent")}
        activeTurnId={null}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        autoFollowTail
        completionDividerAfterEntryId={null}
        completionSummary={null}
        isRevertingCheckpoint={false}
        isWorking={false}
        listRef={createRef<LegendListRef | null>()}
        markdownCwd={undefined}
        onForkMessage={vi.fn()}
        onImageExpand={vi.fn()}
        onIsAtEndChange={vi.fn()}
        onRevertUserMessage={vi.fn()}
        onUserScrollIntent={vi.fn()}
        revertTurnCountByUserMessageId={new Map()}
        stickToEndRevision={0}
        subagentRuntimeSession={{
          subagentRuntimeId: "native-runtime-a",
          orchestrationStatus: "ready",
        }}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt,
            message: {
              id: MessageId.make("message-1"),
              role: "user",
              text: "Open YouTube and check my subscriber count.",
              createdAt,
              streaming: false,
            },
          },
          {
            id: "assistant-entry",
            kind: "message",
            createdAt,
            message: {
              id: MessageId.make("assistant:item-1"),
              role: "assistant",
              text: "I’ll open YouTube and check your channel.",
              createdAt,
              completedAt: "2026-04-13T12:00:03.000Z",
              streaming: false,
              turnId: TurnId.make("turn-1"),
            },
          },
        ]}
        timestampFormat="24-hour"
        workspaceRoot={undefined}
      />
    </div>,
  );
  try {
    const userFooter = document.querySelector<HTMLElement>("[data-user-message-footer]")!;
    const assistantFooter = document.querySelector<HTMLElement>("[data-assistant-message-footer]")!;
    await expect.poll(() => getComputedStyle(userFooter).opacity).toBe("1");
    await expect.poll(() => getComputedStyle(assistantFooter).opacity).toBe("1");
    expect(getComputedStyle(userFooter).position).toBe("static");
    expect(getComputedStyle(assistantFooter).position).toBe("static");
    const bubble = userFooter.closest<HTMLElement>(".group")!;
    expect(userFooter.getBoundingClientRect().bottom).toBeLessThan(
      bubble.getBoundingClientRect().bottom,
    );
    await expect
      .element(page.getByRole("button", { name: "Copy message", exact: true }).first())
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Fork from this message", exact: true }).first())
      .toBeVisible();
    await page.screenshot({ path: "../../../../../.explorations/message-spacing/touch.png" });
  } finally {
    await view.unmount();
  }
});

it("exposes hide options through genuine touch without replacing the primary scroll action", async () => {
  expect(window.matchMedia("(hover: none)").matches).toBe(true);
  expect(window.matchMedia("(pointer: coarse)").matches).toBe(true);
  expect(window.matchMedia("(hover: hover)").matches).toBe(false);
  expect(navigator.maxTouchPoints).toBeGreaterThan(0);
  expect(window.innerWidth).toBe(430);
  expect(window.innerHeight).toBe(932);

  const scroll = vi.fn();
  const hide = vi.fn();
  const touchTargets: Element[] = [];
  const observeTouch = (event: PointerEvent) => {
    if (event.isTrusted && event.pointerType === "touch" && event.target instanceof Element) {
      touchTargets.push(event.target);
    }
  };
  document.addEventListener("pointerdown", observeTouch, { capture: true });
  const input = cdp();
  const tap = async (element: Element) => {
    // A locator can return an SVG as well as an HTML element. Only the exact
    // native button is an admitted action target; reject before sending input
    // rather than asserting a narrower TypeScript type or tapping an icon.
    if (!(element instanceof HTMLButtonElement)) {
      throw new Error("The touch action target must be a native HTML button.");
    }
    const rect = element.getBoundingClientRect();
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBeGreaterThan(0);
    // CDP delivers actual touch input in the already-owned mobile context; it
    // never changes device/media emulation. Account for the tester iframe's
    // real placement instead of assuming its local origin is the page origin.
    const testerRect = window.frameElement?.getBoundingClientRect();
    const x = rect.left + rect.width / 2 + (testerRect?.left ?? 0);
    const y = rect.top + rect.height / 2 + (testerRect?.top ?? 0);
    try {
      await input.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y, id: 1 }],
      });
    } finally {
      // A failed response does not prove that the native contact was refused.
      // Release this exact gesture before another action or fixture teardown.
      await input.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    }
  };
  let view: Awaited<ReturnType<typeof render>> | undefined;
  try {
    view = await render(
      <div
        className="bg-background text-foreground"
        style={{ position: "fixed", left: 16, bottom: 24 }}
      >
        <ScrollToBottomControl onScrollToBottom={scroll} onHideUntilBottom={hide} />
      </div>,
    );
    const primary = page.getByRole("button", { name: "Scroll to bottom", exact: true });
    const options = page.getByRole("button", { name: "Scroll to bottom options", exact: true });
    expect(document.querySelector("[data-scroll-to-bottom-popup]")).toBeNull();
    await tap(primary.element());
    await expect.poll(() => scroll.mock.calls.length).toBe(1);
    expect(hide).not.toHaveBeenCalled();
    await expect.poll(() => document.querySelector("[data-scroll-to-bottom-popup]")).toBeNull();

    await tap(options.element());
    const hideAction = page.getByRole("button", { name: "Hide until bottom", exact: true });
    await expect.element(hideAction).toBeVisible();
    const popup = document.querySelector<HTMLElement>("[data-scroll-to-bottom-popup]")!;
    const popupRect = popup.getBoundingClientRect();
    expect(popupRect.left).toBeGreaterThanOrEqual(0);
    expect(popupRect.right).toBeLessThanOrEqual(window.innerWidth);
    expect(popupRect.top).toBeGreaterThanOrEqual(0);
    expect(popupRect.bottom).toBeLessThanOrEqual(
      document
        .querySelector<HTMLElement>("[data-scroll-to-bottom-control]")!
        .getBoundingClientRect().top + 1,
    );
    expect(scroll).toHaveBeenCalledOnce();
    expect(hide).not.toHaveBeenCalled();
    await tap(hideAction.element());
    await expect.poll(() => hide.mock.calls.length).toBe(1);
    expect(scroll).toHaveBeenCalledOnce();
    await expect.poll(() => document.querySelector("[data-scroll-to-bottom-popup]")).toBeNull();
    expect(touchTargets).toHaveLength(3);
    expect(touchTargets[0]!.closest("[data-scroll-to-bottom-primary]")).toBe(primary.element());
    expect(touchTargets[1]!.closest("[data-scroll-to-bottom-options]")).toBe(options.element());
    expect(touchTargets[2]!.closest("[data-scroll-to-bottom-hide]")).not.toBeNull();
  } finally {
    document.removeEventListener("pointerdown", observeTouch, { capture: true });
    await view?.unmount();
  }
});
