import "../../index.css";

import {
  EnvironmentId,
  MessageId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  type LocalApi,
} from "@cafecode/contracts";
import { createRef } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { __resetEnvironmentApiOverridesForTests } from "../../environmentApi";
import { __resetLocalApiForTests } from "../../localApi";

const scrollToEndSpy = vi.fn();
const scrollToIndexSpy = vi.fn();
const getStateSpy = vi.fn<
  () => {
    isAtEnd: boolean;
    contentLength?: number;
    scroll?: number;
    scrollLength?: number;
  }
>(() => ({ isAtEnd: true }));
const legendListPropsSpy = vi.fn();

vi.mock("@legendapp/list/react", async () => {
  const React = await import("react");

  function LegendList(props: {
    data: Array<{ id: string }>;
    keyExtractor: (item: { id: string }) => string;
    renderItem: (args: { item: { id: string } }) => React.ReactNode;
    ListHeaderComponent?: React.ReactNode;
    ListFooterComponent?: React.ReactNode;
    onWheel?: React.WheelEventHandler<HTMLDivElement>;
    onTouchMove?: React.TouchEventHandler<HTMLDivElement>;
    onPointerDown?: React.PointerEventHandler<HTMLDivElement>;
    onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
    onScroll?: React.UIEventHandler<HTMLDivElement>;
    maintainScrollAtEnd?: boolean;
    maintainVisibleContentPosition?: unknown;
    ref?: React.Ref<LegendListRef>;
  }) {
    legendListPropsSpy(props);
    React.useImperativeHandle(
      props.ref,
      () =>
        ({
          scrollToEnd: scrollToEndSpy,
          scrollToIndex: scrollToIndexSpy,
          getState: getStateSpy,
        }) as unknown as LegendListRef,
    );

    return (
      <div
        data-testid="legend-list"
        onKeyDown={props.onKeyDown}
        onPointerDown={props.onPointerDown}
        onScroll={props.onScroll}
        onTouchMove={props.onTouchMove}
        onWheel={props.onWheel}
      >
        {props.ListHeaderComponent}
        {props.data.map((item) => (
          <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
        ))}
        {props.ListFooterComponent}
      </div>
    );
  }

  return { LegendList };
});

import { MessagesTimeline } from "./MessagesTimeline";

const MESSAGE_CREATED_AT = "2026-04-13T12:00:00.000Z";

function buildProps() {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    activeTurnId: null,
    activeTurnStartedAt: null,
    listRef: createRef<LegendListRef | null>(),
    completionDividerAfterEntryId: null,
    completionSummary: null,
    revertTurnCountByUserMessageId: new Map(),
    onRevertUserMessage: vi.fn(),
    isRevertingCheckpoint: false,
    onImageExpand: vi.fn(),
    activeThreadEnvironmentId: EnvironmentId.make("environment-local"),
    activeProvider: ProviderDriverKind.make("codex"),
    markdownCwd: undefined,
    timestampFormat: "24-hour" as const,
    workspaceRoot: undefined,
    stickToEndRevision: 0,
    autoFollowTail: true,
    onIsAtEndChange: vi.fn(),
    onUserScrollIntent: vi.fn(),
  };
}

function buildLongUserMessageText(tail = "deep hidden detail only after expand") {
  return Array.from({ length: 9 }, (_, index) =>
    index === 8 ? tail : `Line ${index + 1}: ${"verbose prompt content ".repeat(8).trim()}`,
  ).join("\n");
}

function buildUserTimelineEntry(text: string) {
  return {
    id: "entry-1",
    kind: "message" as const,
    createdAt: MESSAGE_CREATED_AT,
    message: {
      id: "message-1" as never,
      role: "user" as const,
      text,
      createdAt: MESSAGE_CREATED_AT,
      streaming: false,
    },
  };
}

function buildAssistantTimelineEntry(input?: {
  text?: string;
  streaming?: boolean;
  turnId?: TurnId | null;
}) {
  return {
    id: "assistant-entry",
    kind: "message" as const,
    createdAt: MESSAGE_CREATED_AT,
    message: {
      id: MessageId.make("assistant:item-1"),
      role: "assistant" as const,
      text: input?.text ?? "assistant answer",
      createdAt: MESSAGE_CREATED_AT,
      completedAt: input?.streaming === true ? undefined : "2026-04-13T12:00:03.000Z",
      streaming: input?.streaming ?? false,
      turnId: input?.turnId === undefined ? TurnId.make("turn-1") : input.turnId,
    },
  };
}

function setNativeContextMenuMock(
  show: (items: readonly unknown[], position?: { x: number; y: number }) => Promise<unknown>,
) {
  (window as typeof window & { nativeApi?: unknown }).nativeApi = {
    contextMenu: { show: show as never },
    persistence: {
      getClientSettings: async () => null,
      setClientSettings: async () => undefined,
    },
  } as unknown as LocalApi;
}

describe("MessagesTimeline", () => {
  afterEach(async () => {
    scrollToEndSpy.mockReset();
    scrollToIndexSpy.mockReset();
    getStateSpy.mockClear();
    legendListPropsSpy.mockReset();
    vi.restoreAllMocks();
    __resetEnvironmentApiOverridesForTests();
    delete (window as typeof window & { nativeApi?: unknown }).nativeApi;
    await __resetLocalApiForTests();
    document.body.innerHTML = "";
  });

  it("renders activity rows instead of the empty placeholder when a thread has non-message timeline data", async () => {
    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "work-1",
            kind: "work",
            createdAt: "2026-04-13T12:00:00.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-04-13T12:00:00.000Z",
              label: "thinking",
              detail: "Inspecting repository state",
              tone: "thinking",
            },
          },
        ]}
      />,
    );

    try {
      await expect
        .element(page.getByText("Send a message to start the conversation."))
        .not.toBeInTheDocument();
      await expect.element(page.getByText("Thinking - Inspecting repository state")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("snaps to the bottom when timeline rows appear after an initially empty render", async () => {
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

    const props = buildProps();
    const screen = await render(<MessagesTimeline {...props} timelineEntries={[]} />);

    try {
      await expect
        .element(page.getByText("Send a message to start the conversation."))
        .toBeVisible();

      await screen.rerender(
        <MessagesTimeline
          {...props}
          timelineEntries={[
            {
              id: "work-1",
              kind: "work",
              createdAt: "2026-04-13T12:00:00.000Z",
              entry: {
                id: "work-1",
                createdAt: "2026-04-13T12:00:00.000Z",
                label: "thinking",
                detail: "Inspecting repository state",
                tone: "thinking",
              },
            },
          ]}
        />,
      );

      await expect.element(page.getByText("Thinking - Inspecting repository state")).toBeVisible();
      expect(props.onIsAtEndChange).toHaveBeenCalledWith(true);
      expect(scrollToEndSpy).toHaveBeenCalledWith({ animated: false });
      expect(requestAnimationFrameSpy).toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("snaps to the bottom when timeline rows are already present on first render", async () => {
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

    const props = buildProps();
    const screen = await render(
      <MessagesTimeline
        {...props}
        timelineEntries={[
          {
            id: "work-1",
            kind: "work",
            createdAt: "2026-04-13T12:00:00.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-04-13T12:00:00.000Z",
              label: "thinking",
              detail: "Inspecting repository state",
              tone: "thinking",
            },
          },
        ]}
      />,
    );

    try {
      await expect.element(page.getByText("Thinking - Inspecting repository state")).toBeVisible();
      expect(props.onIsAtEndChange).toHaveBeenCalledWith(true);
      expect(scrollToEndSpy).toHaveBeenCalledWith({ animated: false });
      expect(requestAnimationFrameSpy).toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("pins appended local messages to the bottom after the submit signal", async () => {
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

    const props = buildProps();
    const firstEntry = buildUserTimelineEntry("existing conversation tail");
    const screen = await render(
      <MessagesTimeline {...props} timelineEntries={[firstEntry]} stickToEndRevision={0} />,
    );

    try {
      scrollToEndSpy.mockClear();
      const nextEntry = {
        ...buildUserTimelineEntry("new local prompt submitted from the bottom"),
        id: "entry-2",
        message: {
          ...buildUserTimelineEntry("new local prompt submitted from the bottom").message,
          id: "message-2" as never,
        },
      };

      await screen.rerender(
        <MessagesTimeline
          {...props}
          timelineEntries={[firstEntry, nextEntry]}
          stickToEndRevision={1}
        />,
      );

      await expect
        .element(page.getByText("new local prompt submitted from the bottom"))
        .toBeVisible();
      expect(props.onIsAtEndChange).toHaveBeenCalledWith(true);
      expect(scrollToEndSpy).toHaveBeenCalledWith({ animated: false });
      expect(scrollToIndexSpy).toHaveBeenCalledWith({
        index: 1,
        animated: false,
        viewPosition: 1,
      });
      expect(requestAnimationFrameSpy).toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("does not let data-change anchoring fight submit-time bottom pinning", async () => {
    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry("existing conversation tail")]}
      />,
    );

    try {
      const lastProps = legendListPropsSpy.mock.calls.at(-1)?.[0] as
        | { maintainVisibleContentPosition?: unknown }
        | undefined;
      expect(lastProps?.maintainVisibleContentPosition).toEqual({
        data: false,
        size: true,
      });
    } finally {
      await screen.unmount();
    }
  });

  it("controls LegendList tail following from the parent state", async () => {
    const props = buildProps();
    const screen = await render(
      <MessagesTimeline
        {...props}
        autoFollowTail={false}
        timelineEntries={[buildUserTimelineEntry("read older context while output streams")]}
      />,
    );

    try {
      const firstProps = legendListPropsSpy.mock.calls.at(-1)?.[0] as
        | { maintainScrollAtEnd?: boolean }
        | undefined;
      expect(firstProps?.maintainScrollAtEnd).toBe(false);

      await screen.rerender(
        <MessagesTimeline
          {...props}
          autoFollowTail={true}
          timelineEntries={[buildUserTimelineEntry("read older context while output streams")]}
        />,
      );

      const lastProps = legendListPropsSpy.mock.calls.at(-1)?.[0] as
        | { maintainScrollAtEnd?: boolean }
        | undefined;
      expect(lastProps?.maintainScrollAtEnd).toBe(true);
    } finally {
      await screen.unmount();
    }
  });

  it("does not force-scroll appended streaming rows while tail following is disabled", async () => {
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

    const props = buildProps();
    const firstEntry = buildUserTimelineEntry("existing conversation tail");
    const screen = await render(
      <MessagesTimeline
        {...props}
        autoFollowTail={false}
        timelineEntries={[firstEntry]}
        isWorking={true}
        activeTurnInProgress={true}
      />,
    );

    try {
      scrollToEndSpy.mockClear();
      scrollToIndexSpy.mockClear();

      const streamingEntry = {
        ...buildAssistantTimelineEntry({
          text: "streaming output that should not steal scroll position",
          streaming: true,
        }),
        id: "assistant-entry-streaming",
        message: {
          ...buildAssistantTimelineEntry({
            text: "streaming output that should not steal scroll position",
            streaming: true,
          }).message,
          id: MessageId.make("assistant:item-streaming"),
        },
      };

      await screen.rerender(
        <MessagesTimeline
          {...props}
          autoFollowTail={false}
          timelineEntries={[firstEntry, streamingEntry]}
          isWorking={true}
          activeTurnInProgress={true}
        />,
      );

      await expect
        .element(page.getByText("streaming output that should not steal scroll position"))
        .toBeVisible();
      const lastProps = legendListPropsSpy.mock.calls.at(-1)?.[0] as
        | { maintainScrollAtEnd?: boolean }
        | undefined;
      expect(lastProps?.maintainScrollAtEnd).toBe(false);
      expect(scrollToEndSpy).not.toHaveBeenCalled();
      expect(scrollToIndexSpy).not.toHaveBeenCalled();
      expect(requestAnimationFrameSpy).toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("does not report stale virtualizer scroll state away from the bottom during submit pinning", async () => {
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    vi.spyOn(Date, "now").mockReturnValue(1_000);

    const props = buildProps();
    const firstEntry = buildUserTimelineEntry("existing conversation tail");
    const screen = await render(
      <MessagesTimeline {...props} timelineEntries={[firstEntry]} stickToEndRevision={0} />,
    );

    try {
      const nextEntry = {
        ...buildUserTimelineEntry("queued local prompt submitted from the bottom"),
        id: "entry-2",
        message: {
          ...buildUserTimelineEntry("queued local prompt submitted from the bottom").message,
          id: "message-2" as never,
        },
      };

      await screen.rerender(
        <MessagesTimeline
          {...props}
          timelineEntries={[firstEntry, nextEntry]}
          stickToEndRevision={1}
        />,
      );

      getStateSpy.mockReturnValueOnce({
        isAtEnd: false,
        contentLength: 10_000,
        scroll: 0,
        scrollLength: 400,
      });
      getStateSpy.mockClear();
      scrollToEndSpy.mockClear();
      scrollToIndexSpy.mockClear();
      const lastProps = legendListPropsSpy.mock.calls.at(-1)?.[0] as
        | { onScroll?: React.UIEventHandler<HTMLDivElement> }
        | undefined;
      lastProps?.onScroll?.({} as React.UIEvent<HTMLDivElement>);

      expect(props.onIsAtEndChange).toHaveBeenLastCalledWith(true);
      expect(props.onIsAtEndChange).not.toHaveBeenCalledWith(false);
      expect(getStateSpy).toHaveBeenCalledTimes(1);
      expect(scrollToEndSpy).toHaveBeenCalledWith({ animated: false });
      expect(scrollToIndexSpy).toHaveBeenCalledWith({
        index: 1,
        animated: false,
        viewPosition: 1,
      });
      expect(requestAnimationFrameSpy).toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("emits scroll diagnostics while submit pinning suppresses stale top scroll reports", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(
      (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
    );
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    vi.spyOn(Date, "now").mockReturnValue(1_000);

    const props = buildProps();
    const onDebugScrollEvent = vi.fn();
    const firstEntry = buildUserTimelineEntry("existing conversation tail");
    const screen = await render(
      <MessagesTimeline
        {...props}
        timelineEntries={[firstEntry]}
        stickToEndRevision={0}
        onDebugScrollEvent={onDebugScrollEvent}
      />,
    );

    try {
      const nextEntry = {
        ...buildUserTimelineEntry("queued local prompt submitted from the bottom"),
        id: "entry-2",
        message: {
          ...buildUserTimelineEntry("queued local prompt submitted from the bottom").message,
          id: "message-2" as never,
        },
      };

      await screen.rerender(
        <MessagesTimeline
          {...props}
          timelineEntries={[firstEntry, nextEntry]}
          stickToEndRevision={1}
          onDebugScrollEvent={onDebugScrollEvent}
        />,
      );

      expect(onDebugScrollEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "MessagesTimeline",
          reason: "submit-stick-immediate",
          metrics: expect.objectContaining({
            rowCount: 2,
            autoFollowTail: true,
            stickToEndRevision: 1,
            submitStickDeadlineRemainingMs: 1_500,
          }),
        }),
      );

      getStateSpy.mockReturnValueOnce({
        isAtEnd: false,
        contentLength: 10_000,
        scroll: 0,
        scrollLength: 400,
      });
      scrollToEndSpy.mockClear();
      scrollToIndexSpy.mockClear();
      const lastProps = legendListPropsSpy.mock.calls.at(-1)?.[0] as
        | { onScroll?: React.UIEventHandler<HTMLDivElement> }
        | undefined;
      lastProps?.onScroll?.({} as React.UIEvent<HTMLDivElement>);

      expect(onDebugScrollEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "scroll-event-ignored-during-submit-stick",
          metrics: expect.objectContaining({
            isAtEnd: false,
            contentLength: 10_000,
            scroll: 0,
            scrollLength: 400,
            remainingScrollDistance: 9_600,
          }),
          details: expect.objectContaining({
            resolvedIsAtEnd: true,
            repinScheduled: true,
          }),
        }),
      );
      expect(onDebugScrollEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "submit-stick-scroll-event-repin",
          details: expect.objectContaining({
            result: "requested",
            targetIndex: 1,
          }),
        }),
      );
      expect(props.onIsAtEndChange).toHaveBeenLastCalledWith(true);
      expect(props.onIsAtEndChange).not.toHaveBeenCalledWith(false);
      expect(scrollToEndSpy).toHaveBeenCalledWith({ animated: false });
      expect(scrollToIndexSpy).toHaveBeenCalledWith({
        index: 1,
        animated: false,
        viewPosition: 1,
      });
    } finally {
      await screen.unmount();
    }
  });

  it("keeps submit pinning active for delayed server row replacement", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(
      (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
    );
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    let nowMs = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);

    const props = buildProps();
    const onDebugScrollEvent = vi.fn();
    const firstEntry = buildUserTimelineEntry("existing conversation tail");
    const submittedEntry = {
      ...buildUserTimelineEntry("queued local prompt submitted from the bottom"),
      id: "entry-2",
      message: {
        ...buildUserTimelineEntry("queued local prompt submitted from the bottom").message,
        id: "message-2" as never,
      },
    };
    const serverAssistantEntry = buildAssistantTimelineEntry({
      text: "server turn acknowledged after a slow projection update",
      streaming: true,
      turnId: TurnId.make("turn-delayed"),
    });
    const screen = await render(
      <MessagesTimeline
        {...props}
        timelineEntries={[firstEntry]}
        stickToEndRevision={0}
        onDebugScrollEvent={onDebugScrollEvent}
      />,
    );

    try {
      await screen.rerender(
        <MessagesTimeline
          {...props}
          timelineEntries={[firstEntry, submittedEntry]}
          stickToEndRevision={1}
          onDebugScrollEvent={onDebugScrollEvent}
        />,
      );

      scrollToEndSpy.mockClear();
      scrollToIndexSpy.mockClear();
      onDebugScrollEvent.mockClear();
      nowMs = 2_000;

      await screen.rerender(
        <MessagesTimeline
          {...props}
          timelineEntries={[firstEntry, submittedEntry, serverAssistantEntry]}
          stickToEndRevision={1}
          onDebugScrollEvent={onDebugScrollEvent}
        />,
      );

      expect(scrollToEndSpy).toHaveBeenCalled();
      expect(scrollToIndexSpy).toHaveBeenCalled();
      expect(onDebugScrollEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "submit-stick-row-update",
          metrics: expect.objectContaining({
            submitStickDeadlineRemainingMs: 500,
          }),
          details: expect.objectContaining({
            result: "requested",
          }),
        }),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("reports explicit wheel scrolling as user scroll intent", async () => {
    const props = buildProps();
    const screen = await render(
      <MessagesTimeline
        {...props}
        timelineEntries={[buildUserTimelineEntry("keep position when I intentionally scroll")]}
      />,
    );

    try {
      const list = document.querySelector("[data-testid='legend-list']");
      list?.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));

      expect(props.onUserScrollIntent).toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("collapses the newest long user message and lets the user expand and re-collapse it", async () => {
    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
      />,
    );

    try {
      const expandButton = page.getByRole("button", { name: "Show full message" });
      await expect.element(expandButton).toBeVisible();
      await expect.element(expandButton).toHaveAttribute("aria-expanded", "false");
      const messageBody = document.querySelector<HTMLElement>("[data-user-message-body='true']");
      expect(messageBody).not.toBeNull();
      const collapsedHeight = messageBody!.getBoundingClientRect().height;
      expect(collapsedHeight).toBeGreaterThan(0);
      expect(messageBody!.scrollHeight).toBeGreaterThan(messageBody!.clientHeight);

      await expandButton.click();

      const collapseButton = page.getByRole("button", { name: "Show less" });
      await expect.element(collapseButton).toBeVisible();
      await expect.element(collapseButton).toHaveAttribute("aria-expanded", "true");

      await vi.waitFor(() => {
        expect(messageBody!.getBoundingClientRect().height).toBeGreaterThan(collapsedHeight);
        expect(messageBody!.clientHeight).toBe(messageBody!.scrollHeight);
      });
      const expandedHeight = messageBody!.getBoundingClientRect().height;

      await collapseButton.click();

      const collapsedAgainButton = page.getByRole("button", { name: "Show full message" });
      await expect.element(collapsedAgainButton).toHaveAttribute("aria-expanded", "false");
      await vi.waitFor(() => {
        expect(messageBody!.getBoundingClientRect().height).toBeLessThan(expandedHeight);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("opens an assistant message context menu without message repair", async () => {
    const threadId = ThreadId.make("thread-1");
    const showContextMenu = vi.fn(
      async (_items: readonly unknown[], _position?: { x: number; y: number }) => null,
    );
    setNativeContextMenuMock(showContextMenu);

    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        activeThreadId={threadId}
        timelineEntries={[buildAssistantTimelineEntry()]}
      />,
    );

    try {
      const assistantRegion = document.querySelector("[data-chat-copy-region='assistant']");
      assistantRegion?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 25,
          clientY: 30,
        }),
      );

      await vi.waitFor(() => {
        expect(showContextMenu).toHaveBeenCalledTimes(1);
      });
      expect(showContextMenu).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ id: "copy-message" })]),
        { x: 25, y: 30 },
      );
      const items = showContextMenu.mock.calls[0]?.[0] as unknown as ReadonlyArray<{ id: string }>;
      expect(items.map((item) => item.id)).not.toContain("repair-from-provider-journal");
    } finally {
      await screen.unmount();
    }
  });

  it("does not open the assistant context menu while text is selected", async () => {
    const showContextMenu = vi.fn(
      async (_items: readonly unknown[], _position?: { x: number; y: number }) =>
        "repair-from-provider-journal",
    );
    setNativeContextMenuMock(showContextMenu);
    vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: false,
      toString: () => "selected assistant text",
    } as Selection);

    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        activeThreadId={ThreadId.make("thread-1")}
        timelineEntries={[buildAssistantTimelineEntry()]}
      />,
    );

    try {
      const assistantRegion = document.querySelector("[data-chat-copy-region='assistant']");
      assistantRegion?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 25,
          clientY: 30,
        }),
      );

      expect(showContextMenu).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("lets Markdown file links keep their own context menu inside assistant messages", async () => {
    const showContextMenu = vi.fn(
      async (_items: readonly unknown[], _position?: { x: number; y: number }) => null,
    );
    setNativeContextMenuMock(showContextMenu);

    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        activeThreadId={ThreadId.make("thread-1")}
        markdownCwd="/tmp/project"
        workspaceRoot="/tmp/project"
        timelineEntries={[
          buildAssistantTimelineEntry({
            text: "Open [App.tsx](file:///tmp/project/src/App.tsx)",
          }),
        ]}
      />,
    );

    try {
      await vi.waitFor(() => {
        expect(document.querySelector("a.chat-markdown-file-link")).not.toBeNull();
      });
      const link = document.querySelector("a.chat-markdown-file-link");
      link?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 11,
        }),
      );

      await vi.waitFor(() => {
        expect(showContextMenu).toHaveBeenCalledTimes(1);
      });
      const items = showContextMenu.mock.calls[0]?.[0] as unknown as ReadonlyArray<{
        id: string;
      }>;
      const itemIds = items.map((item) => item.id);
      expect(itemIds).toContain("copy-relative");
      expect(itemIds).toContain("copy-full");
      expect(itemIds).not.toContain("repair-from-provider-journal");
    } finally {
      await screen.unmount();
    }
  });
});
