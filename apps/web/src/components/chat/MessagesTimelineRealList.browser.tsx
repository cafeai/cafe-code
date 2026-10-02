import "../../index.css";

import { EnvironmentId, MessageId, ProviderDriverKind, ThreadId } from "@cafecode/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef, useCallback, useState, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { MessagesTimeline } from "./MessagesTimeline";

type TimelineProps = ComponentProps<typeof MessagesTimeline>;
type TimelineEntries = TimelineProps["timelineEntries"];

const CREATED_AT = "2026-09-20T12:00:00.000Z";
const EMPTY_REVERT_COUNTS = new Map<MessageId, number>();
const ignore = () => undefined;

function messages(scope: string, count = 40): TimelineEntries {
  return Array.from({ length: count }, (_, index) => ({
    id: `${scope}-entry-${index}`,
    kind: "message" as const,
    createdAt: CREATED_AT,
    message: {
      id: MessageId.make(`${scope}-message-${index}`),
      role: "user" as const,
      text: `${scope} message ${index}\nA bounded synthetic message for the real virtualizer.`,
      createdAt: CREATED_AT,
      streaming: false,
    },
  }));
}

function growLastMessage(entries: TimelineEntries): TimelineEntries {
  return entries.map((entry, index) =>
    index === entries.length - 1 && entry.kind === "message"
      ? {
          ...entry,
          message: {
            ...entry.message,
            text: `${entry.message.text}\nAn additional measured line.\nThe final measured line.`,
          },
        }
      : entry,
  );
}

/**
 * Exercise Cafe's real row rendering, ResizeObserver measurements and list ref.
 * Only the parent-owned follow decision is represented here: user review turns
 * it off, and a keyed thread change starts a fresh following view, as ChatView
 * does. No provider, backend transport or LegendList implementation is mocked.
 */
function TimelineFixture({
  entries,
  listRef,
  scope,
}: {
  entries: TimelineEntries;
  listRef: TimelineProps["listRef"];
  scope: string;
}) {
  const [following, setFollowing] = useState(true);
  const stopFollowing = useCallback(() => setFollowing(false), []);

  return (
    <div className="h-full min-h-0" data-real-list-following={following}>
      <MessagesTimeline
        activeThreadId={ThreadId.make(scope)}
        activeThreadEnvironmentId={EnvironmentId.make("real-list-fixture")}
        activeProvider={ProviderDriverKind.make("codex")}
        activeTurnId={null}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        autoFollowTail={following}
        completionDividerAfterEntryId={null}
        completionSummary={null}
        isRevertingCheckpoint={false}
        isWorking={false}
        listRef={listRef}
        markdownCwd={undefined}
        onImageExpand={ignore}
        onIsAtEndChange={ignore}
        onRevertUserMessage={ignore}
        onUserScrollIntent={stopFollowing}
        revertTurnCountByUserMessageId={EMPTY_REVERT_COUNTS}
        stickToEndRevision={0}
        timelineEntries={entries}
        timestampFormat="24-hour"
        workspaceRoot={undefined}
      />
    </div>
  );
}

function createHost(): HTMLDivElement {
  const host = document.createElement("div");
  host.style.width = "min(760px, 100vw)";
  host.style.height = "360px";
  document.body.append(host);
  return host;
}

function readScroller(listRef: TimelineProps["listRef"]): HTMLElement {
  const scroller = listRef.current?.getScrollableNode();
  expect(scroller).toBeInstanceOf(HTMLElement);
  return scroller!;
}

function tailDistance(scroller: HTMLElement): number {
  return scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
}

function readMessage(host: HTMLElement, id: string): HTMLElement {
  const row = host.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
  expect(row).not.toBeNull();
  return row!;
}

async function expectTail(
  host: HTMLElement,
  listRef: TimelineProps["listRef"],
  lastMessageId: string,
  stage = "initial",
) {
  await vi.waitFor(() => {
    const scroller = readScroller(listRef);
    const row = readMessage(host, lastMessageId);
    const viewport = scroller.getBoundingClientRect();
    const message = row.getBoundingClientRect();
    const spacers = host.querySelectorAll<HTMLElement>("div.h-3.sm\\:h-4");
    expect(spacers).toHaveLength(2);
    const footerHeight = spacers[1]!.getBoundingClientRect().height;
    // Assert physical layout as well as identity. A mocked ref, a zero-height
    // viewport or an offscreen recycled row must not satisfy this smoke test.
    expect(scroller.clientHeight).toBeGreaterThan(200);
    expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight + 500);
    // Cafe issues both scrollToEnd and last-row scrollToIndex. The latter can
    // align the last row rather than its trailing spacer. Admit only that
    // measured footer, never a viewport-sized threshold hiding missing rows.
    expect(Math.abs(tailDistance(scroller)), `${stage}: ${lastMessageId}`).toBeLessThanOrEqual(
      footerHeight + 4,
    );
    expect(message.bottom).toBeLessThanOrEqual(viewport.bottom + 2);
    expect(message.bottom).toBeGreaterThanOrEqual(viewport.bottom - footerHeight - 4);
  });
}

describe("MessagesTimeline with real LegendList", () => {
  it("opens at the newest message and follows appended rows and row growth", async () => {
    const host = createHost();
    const listRef = createRef<LegendListRef>();
    let entries = messages("follow");
    const view = await render(
      <TimelineFixture entries={entries} listRef={listRef} scope="follow" />,
      { container: host },
    );
    try {
      await expectTail(host, listRef, "follow-message-39");
      // Forty rows exceed both the viewport and the small default buffer: this
      // must be an actual virtualized window, not an eagerly rendered fixture.
      expect(host.querySelector('[data-message-id="follow-message-0"]')).toBeNull();

      // Following is conditional on the physical tail. The initial last-row
      // target can leave its footer below the viewport; explicitly reach that
      // tail before testing the distinct append/measurement-follow contract.
      // Let Cafe's three initial alignment frames finish before this movement.
      for (let frame = 0; frame < 4; frame += 1) {
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      }
      const scroller = readScroller(listRef);
      scroller.scrollTop = scroller.scrollHeight;
      await vi.waitFor(() => {
        expect(Math.abs(tailDistance(scroller))).toBeLessThanOrEqual(2);
        expect(listRef.current?.getState().isAtEnd).toBe(true);
      });

      entries = messages("follow", 41);
      await view.rerender(<TimelineFixture entries={entries} listRef={listRef} scope="follow" />);
      await expectTail(host, listRef, "follow-message-40", "append");
      const previousHeight = readMessage(host, "follow-message-40").getBoundingClientRect().height;

      entries = growLastMessage(entries);
      await view.rerender(<TimelineFixture entries={entries} listRef={listRef} scope="follow" />);
      await vi.waitFor(() => {
        expect(
          readMessage(host, "follow-message-40").getBoundingClientRect().height,
        ).toBeGreaterThan(previousHeight + 20);
      });
      await expectTail(host, listRef, "follow-message-40", "row growth");
    } finally {
      await view.unmount();
      host.remove();
    }
  });

  it("reuses the parent ref across keyed thread changes without retaining old rows or scroll targets", async () => {
    const host = createHost();
    const listRef = createRef<LegendListRef>();
    const view = await render(
      <TimelineFixture key="first" entries={messages("first")} listRef={listRef} scope="first" />,
      { container: host },
    );
    try {
      await expectTail(host, listRef, "first-message-39");
      const previousScroller = readScroller(listRef);
      await view.rerender(
        <TimelineFixture
          key="second"
          entries={messages("second", 24)}
          listRef={listRef}
          scope="second"
        />,
      );
      await expectTail(host, listRef, "second-message-23");
      expect(readScroller(listRef)).not.toBe(previousScroller);
      expect(previousScroller.isConnected).toBe(false);
      expect(host.querySelector('[data-message-id^="first-message-"]')).toBeNull();
    } finally {
      await view.unmount();
      host.remove();
    }
  });
});
