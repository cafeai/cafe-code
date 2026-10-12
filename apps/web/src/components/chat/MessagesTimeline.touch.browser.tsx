import "../../index.css";

import { EnvironmentId, MessageId, ProviderDriverKind, TurnId } from "@cafecode/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef, type ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { page } from "vitest/browser";
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
