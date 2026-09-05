import "../../index.css";

import {
  EnvironmentId,
  EventId,
  MessageId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  type EnvironmentApi,
  type LocalApi,
} from "@cafecode/contracts";
import { createRef } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
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
    onTouchStart?: React.TouchEventHandler<HTMLDivElement>;
    onTouchMove?: React.TouchEventHandler<HTMLDivElement>;
    onTouchEnd?: React.TouchEventHandler<HTMLDivElement>;
    onTouchCancel?: React.TouchEventHandler<HTMLDivElement>;
    onPointerDown?: React.PointerEventHandler<HTMLDivElement>;
    onPointerUp?: React.PointerEventHandler<HTMLDivElement>;
    onPointerCancel?: React.PointerEventHandler<HTMLDivElement>;
    onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
    onScroll?: React.UIEventHandler<HTMLDivElement>;
    onItemSizeChanged?: (info: {
      size: number;
      previous: number;
      index: number;
      itemKey: string;
      itemData: { id: string };
    }) => void;
    maintainScrollAtEnd?: boolean;
    maintainScrollAtEndThreshold?: number;
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
        onPointerCancel={props.onPointerCancel}
        onPointerDown={props.onPointerDown}
        onPointerUp={props.onPointerUp}
        onScroll={props.onScroll}
        onTouchCancel={props.onTouchCancel}
        onTouchEnd={props.onTouchEnd}
        onTouchMove={props.onTouchMove}
        onTouchStart={props.onTouchStart}
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
import type { SubagentDetailSelection } from "./SubagentDetailView";

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

function buildLiveSubagentWorkEntry(id: string, label: string) {
  return {
    id,
    kind: "work" as const,
    createdAt: "2026-04-13T12:00:00.000Z",
    entry: {
      id,
      createdAt: "2026-04-13T12:00:00.000Z",
      label,
      detail: `${label} objective`,
      tone: "thinking" as const,
      itemType: "collab_agent_tool_call" as const,
      subagent: {
        id: `provider-${id}`,
        label,
        description: `${label} progress`,
        status: "active" as const,
        startedAt: "2026-04-13T12:00:00.000Z",
      },
    },
  };
}

function buildSubagentWorkEntry(input: {
  id: string;
  label: string;
  subagentId: string;
  turnId: TurnId;
  status: "active" | "waiting" | "completed" | "failed" | "stopped";
  startedAt?: string;
  completedAt?: string;
  updatedAt?: string;
  lifecycleRevision?: string;
  historyId?: string;
  description?: string;
  objective?: string;
}) {
  const startedAt = input.startedAt ?? "2026-04-13T12:00:00.000Z";
  const objective = input.objective ?? `${input.label} objective`;
  return {
    id: input.id,
    kind: "work" as const,
    createdAt: startedAt,
    entry: {
      id: input.id,
      turnId: input.turnId,
      createdAt: startedAt,
      label: input.label,
      detail: objective,
      tone:
        input.status === "active" || input.status === "waiting"
          ? ("thinking" as const)
          : input.status === "failed"
            ? ("error" as const)
            : ("info" as const),
      itemType: "collab_agent_tool_call" as const,
      subagent: {
        id: input.subagentId,
        label: input.label,
        objective,
        description: input.description ?? `${input.label} progress`,
        status: input.status,
        startedAt,
        updatedAt: input.updatedAt ?? startedAt,
        lifecycleRevision: input.lifecycleRevision ?? `revision:${input.id}`,
        ...(input.historyId ? { historyId: input.historyId } : {}),
        ...(input.completedAt ? { completedAt: input.completedAt } : {}),
      },
    },
  };
}

function setSubagentDetailApi(
  getThreadTurnSubagentDetail: EnvironmentApi["orchestration"]["getThreadTurnSubagentDetail"],
) {
  __setEnvironmentApiOverrideForTests(EnvironmentId.make("environment-local"), {
    orchestration: { getThreadTurnSubagentDetail },
  } as unknown as EnvironmentApi);
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

  it("shows a friendly loading scene until an empty thread detail snapshot is conclusive", async () => {
    const props = buildProps();
    const screen = await render(
      <MessagesTimeline {...props} isThreadHistoryHydrating timelineEntries={[]} />,
    );

    try {
      await expect.element(page.getByText("Restoring your conversation")).toBeVisible();
      await expect
        .element(
          page.getByText(
            "Cafe is gathering this thread's history. It'll be ready to continue in just a moment.",
          ),
        )
        .toBeVisible();
      await expect
        .element(page.getByText("Send a message to start the conversation."))
        .not.toBeInTheDocument();

      const loadingState = document.querySelector<HTMLElement>(
        '[data-thread-history-loading="true"]',
      );
      expect(loadingState?.getAttribute("role")).toBe("status");

      await screen.rerender(
        <MessagesTimeline {...props} isThreadHistoryHydrating={false} timelineEntries={[]} />,
      );

      await expect
        .element(page.getByText("Send a message to start the conversation."))
        .toBeVisible();
      await expect.element(page.getByText("Restoring your conversation")).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("shares one visibility-aware clock across live subagents and leaves terminal timing frozen", async () => {
    let now = Date.parse("2026-04-13T12:01:05.000Z");
    let visibility: DocumentVisibilityState = "visible";
    let nextIntervalId = 1;
    const activeIntervals = new Map<number, () => void>();

    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    vi.spyOn(window, "setInterval").mockImplementation((handler) => {
      const intervalId = nextIntervalId;
      nextIntervalId += 1;
      activeIntervals.set(intervalId, () => handler(undefined));
      return intervalId as unknown as ReturnType<typeof window.setInterval>;
    });
    vi.spyOn(window, "clearInterval").mockImplementation((intervalId) => {
      activeIntervals.delete(Number(intervalId));
    });

    const terminalEntry = {
      id: "subagent-terminal",
      kind: "work" as const,
      createdAt: "2026-04-13T12:00:00.000Z",
      entry: {
        id: "subagent-terminal",
        createdAt: "2026-04-13T12:00:00.000Z",
        label: "Finished worker",
        detail: "Finished objective",
        tone: "info" as const,
        itemType: "collab_agent_tool_call" as const,
        subagent: {
          id: "provider-terminal",
          label: "Finished worker",
          description: "Finished progress",
          status: "completed" as const,
          startedAt: "2026-04-13T12:00:00.000Z",
          completedAt: "2026-04-13T12:00:10.000Z",
        },
      },
    };

    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildLiveSubagentWorkEntry("subagent-live-1", "Live worker one"),
          buildLiveSubagentWorkEntry("subagent-live-2", "Live worker two"),
          terminalEntry,
        ]}
      />,
    );
    let mounted = true;

    try {
      await vi.waitFor(() => {
        expect(document.querySelectorAll('[data-subagent-live-elapsed="true"]')).toHaveLength(2);
        expect(activeIntervals.size).toBe(1);
      });
      const terminalElapsed = document.querySelector<HTMLElement>(
        '[data-subagent-terminal-elapsed="true"]',
      );
      expect(terminalElapsed?.textContent).toBe("10s");

      now += 1_000;
      activeIntervals.values().next().value?.();
      await vi.waitFor(() => {
        expect(
          Array.from(
            document.querySelectorAll<HTMLElement>('[data-subagent-live-elapsed="true"]'),
          ).map((element) => element.textContent),
        ).toEqual(["1m 6s", "1m 6s"]);
      });
      expect(terminalElapsed?.textContent).toBe("10s");

      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      expect(activeIntervals.size).toBe(0);

      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      expect(activeIntervals.size).toBe(1);

      await screen.unmount();
      mounted = false;
      expect(activeIntervals.size).toBe(0);
    } finally {
      if (mounted) await screen.unmount();
    }
  });

  it("opens scoped subagent history from semantic active and terminal rows and restores focus", async () => {
    const threadId = ThreadId.make("cafe-thread-detail-1");
    const activeTurnId = TurnId.make("cafe-turn-active-1");
    const terminalTurnId = TurnId.make("cafe-turn-terminal-1");
    const getThreadTurnSubagentDetail = vi.fn(
      async (_input: { threadId: ThreadId; turnId: TurnId; subagentId: string }) => ({
        provider: ProviderDriverKind.make("codex"),
        messages: [
          {
            key: "assignment",
            role: "user" as const,
            text: "Audit **scoped input** and preserve `safe.md`.",
          },
          {
            key: "progress",
            role: "assistant" as const,
            text: "Progress: the bounded provider transcript is available.",
            omission: {
              tail: "Newest progress remains visible after the middle omission.",
              omittedUtf8Bytes: 2_048,
            },
          },
          {
            key: "result",
            role: "assistant" as const,
            text: "## Result\n\nCompleted **safely** with bounded output.",
          },
        ],
        gaps: [
          {
            afterMessageKey: "assignment",
            omittedMessages: 7,
            omittedUtf8Bytes: 4_096,
          },
        ],
        truncated: true,
      }),
    );
    setSubagentDetailApi(getThreadTurnSubagentDetail);

    const activeEntry = buildSubagentWorkEntry({
      id: "subagent-active-detail",
      label: "Active detail worker",
      subagentId: " codex-child-active-exact ",
      turnId: activeTurnId,
      status: "active",
      description: "Indexing the scoped provider transcript",
      historyId: " history  id-preserved-exactly ",
    });
    const terminalEntry = buildSubagentWorkEntry({
      id: "subagent-terminal-detail",
      label: "Terminal detail worker",
      subagentId: "codex-child-terminal-exact",
      turnId: terminalTurnId,
      status: "completed",
      completedAt: "2026-04-13T12:00:10.000Z",
      description: "Saved terminal lifecycle detail",
    });
    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        activeThreadId={threadId}
        timelineEntries={[activeEntry, terminalEntry]}
      />,
    );

    try {
      const activeButton = document.querySelector<HTMLButtonElement>(
        'button[data-subagent-work-row="true"][aria-label^="Active detail worker,"]',
      );
      const terminalButton = document.querySelector<HTMLButtonElement>(
        'button[data-subagent-work-row="true"][aria-label^="Terminal detail worker,"]',
      );
      expect(activeButton).not.toBeNull();
      expect(terminalButton).not.toBeNull();
      expect(activeButton?.type).toBe("button");
      expect(terminalButton?.type).toBe("button");
      expect(activeButton?.getAttribute("aria-label")).toContain("Working");
      expect(terminalButton?.getAttribute("aria-label")).toContain("Done");

      await page.getByRole("button", { name: /^Active detail worker, Working\./ }).click();
      await vi.waitFor(() => {
        expect(getThreadTurnSubagentDetail).toHaveBeenCalledWith({
          threadId,
          turnId: activeTurnId,
          subagentId: " codex-child-active-exact ",
          historyId: " history  id-preserved-exactly ",
        });
      });

      await expect
        .element(page.getByRole("region", { name: "Subagent detail: Active detail worker" }))
        .toBeVisible();
      expect(document.querySelectorAll('[data-subagent-detail-message="user"]')).toHaveLength(1);
      expect(document.querySelectorAll('[data-subagent-detail-message="assistant"]')).toHaveLength(
        2,
      );
      await expect.element(page.getByText("scoped input", { exact: true })).toBeVisible();
      await expect.element(page.getByText("safe.md", { exact: true })).toBeVisible();
      await expect.element(page.getByRole("heading", { name: "Result" })).toBeVisible();
      await expect.element(page.getByText("safely", { exact: true })).toBeVisible();
      await expect.element(page.getByText(/7 intermediate updates omitted/)).toBeVisible();
      await expect.element(page.getByText(/2,048 bytes omitted from the middle/)).toBeVisible();
      await expect.element(page.getByText(/Newest progress remains visible/)).toBeVisible();

      const backButton = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Back to conversation"]',
      );
      await vi.waitFor(() => expect(document.activeElement).toBe(backButton));
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => {
        expect(document.querySelector('[data-subagent-detail-view="true"]')).toBeNull();
        expect(document.activeElement).toBe(activeButton);
      });

      await activeButton!.click();
      await vi.waitFor(() => {
        expect(getThreadTurnSubagentDetail).toHaveBeenCalledTimes(2);
        expect(document.querySelector('[data-subagent-detail-view="true"]')).not.toBeNull();
      });
      await page.getByRole("button", { name: "Back to conversation" }).click();
      await vi.waitFor(() => {
        expect(document.querySelector('[data-subagent-detail-view="true"]')).toBeNull();
        expect(document.activeElement).toBe(activeButton);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("refreshes an open live detail on provider lifecycle revisions", async () => {
    const threadId = ThreadId.make("cafe-thread-live-detail");
    const turnId = TurnId.make("cafe-turn-live-detail");
    const getThreadTurnSubagentDetail = vi.fn(async () => {
      const revision = getThreadTurnSubagentDetail.mock.calls.length;
      return {
        provider: ProviderDriverKind.make("codex"),
        messages: [
          {
            key: `update-${revision}`,
            role: "assistant" as const,
            text: revision === 1 ? "Initial live update" : "Latest live update",
          },
        ],
        gaps: [],
        truncated: false,
      };
    });
    setSubagentDetailApi(getThreadTurnSubagentDetail);
    const props = buildProps();
    const first = buildSubagentWorkEntry({
      id: "subagent-live-detail",
      label: "Live detail worker",
      subagentId: "codex-child-live-detail",
      turnId,
      status: "active",
      updatedAt: "2026-04-13T12:00:01.000Z",
      lifecycleRevision: "sequence:1:first",
    });
    const screen = await render(
      <MessagesTimeline {...props} activeThreadId={threadId} timelineEntries={[first]} />,
    );

    try {
      await page.getByRole("button", { name: /^Live detail worker, Working\./ }).click();
      await expect.element(page.getByText("Initial live update", { exact: true })).toBeVisible();

      const revised = buildSubagentWorkEntry({
        id: "subagent-live-detail",
        label: "Live detail worker",
        subagentId: "codex-child-live-detail",
        turnId,
        status: "active",
        // Wall-clock timestamps can collide across a burst; the durable
        // lifecycle revision must still invalidate the open transcript.
        updatedAt: "2026-04-13T12:00:01.000Z",
        lifecycleRevision: "sequence:2:second",
      });
      await screen.rerender(
        <MessagesTimeline {...props} activeThreadId={threadId} timelineEntries={[revised]} />,
      );
      const coalesced = buildSubagentWorkEntry({
        id: "subagent-live-detail",
        label: "Live detail worker",
        subagentId: "codex-child-live-detail",
        turnId,
        status: "active",
        updatedAt: "2026-04-13T12:00:01.000Z",
        lifecycleRevision: "sequence:3:third",
      });
      await screen.rerender(
        <MessagesTimeline {...props} activeThreadId={threadId} timelineEntries={[coalesced]} />,
      );
      await vi.waitFor(() => expect(getThreadTurnSubagentDetail).toHaveBeenCalledTimes(2), {
        timeout: 2_500,
      });
      await expect.element(page.getByText("Latest live update", { exact: true })).toBeVisible();
      expect(getThreadTurnSubagentDetail).toHaveBeenCalledTimes(2);
    } finally {
      await screen.unmount();
    }
  });

  it("remounts detail state when a controlled selection changes between equal-timestamp workers", async () => {
    const environmentId = EnvironmentId.make("environment-local");
    const threadId = ThreadId.make("cafe-thread-switch-detail");
    const turnId = TurnId.make("cafe-turn-switch-detail");
    const first = buildSubagentWorkEntry({
      id: "subagent-switch-first",
      label: "First detail worker",
      subagentId: "child-switch-first",
      turnId,
      status: "completed",
      completedAt: "2026-04-13T12:00:10.000Z",
    });
    const second = buildSubagentWorkEntry({
      id: "subagent-switch-second",
      label: "Second detail worker",
      subagentId: "child-switch-second",
      turnId,
      status: "completed",
      completedAt: "2026-04-13T12:00:10.000Z",
    });
    const selection = (
      entry: ReturnType<typeof buildSubagentWorkEntry>,
    ): SubagentDetailSelection => ({
      environmentId,
      threadId,
      rowId: entry.entry.id,
      turnId,
      workEntry: entry.entry,
    });
    const getThreadTurnSubagentDetail = vi.fn(async (request: { readonly subagentId: string }) => {
      if (request.subagentId === "child-switch-second") {
        throw new Error("second history is transiently unavailable");
      }
      return {
        provider: ProviderDriverKind.make("codex"),
        messages: [
          {
            key: "first-private-result",
            role: "assistant" as const,
            text: "First worker transcript must not leak into the second selection",
          },
        ],
        gaps: [],
        truncated: false,
      };
    });
    setSubagentDetailApi(getThreadTurnSubagentDetail);
    const props = buildProps();
    const screen = await render(
      <MessagesTimeline
        {...props}
        activeThreadId={threadId}
        timelineEntries={[first, second]}
        selectedSubagent={selection(first)}
        onCloseSubagentDetail={vi.fn()}
      />,
    );

    try {
      await expect
        .element(
          page.getByText("First worker transcript must not leak into the second selection", {
            exact: true,
          }),
        )
        .toBeVisible();

      await screen.rerender(
        <MessagesTimeline
          {...props}
          activeThreadId={threadId}
          timelineEntries={[first, second]}
          selectedSubagent={selection(second)}
          onCloseSubagentDetail={vi.fn()}
        />,
      );

      await vi.waitFor(() => {
        expect(document.querySelector('[data-subagent-detail-unavailable="true"]')).not.toBeNull();
      });
      expect(document.body.textContent).not.toContain(
        "First worker transcript must not leak into the second selection",
      );
      expect(
        document.querySelector('[aria-label="Subagent detail: Second detail worker"]'),
      ).not.toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("does not reinterpret Claude private-use text as Codex citations", async () => {
    const threadId = ThreadId.make("cafe-thread-claude-citations");
    const turnId = TurnId.make("cafe-turn-claude-citations");
    const markerText = "Claude literal \uE200cite\uE202turn4search3\uE201 remains provider text.";
    setSubagentDetailApi(async () => ({
      provider: ProviderDriverKind.make("claudeAgent"),
      messages: [{ key: "claude-private-use", role: "assistant", text: markerText }],
      gaps: [],
      truncated: false,
    }));
    const entry = buildSubagentWorkEntry({
      id: "subagent-claude-citations",
      label: "Claude citation worker",
      subagentId: "claude-child-citation",
      turnId,
      status: "completed",
      completedAt: "2026-04-13T12:00:10.000Z",
    });
    const props = buildProps();
    const screen = await render(
      <MessagesTimeline
        {...props}
        activeProvider={ProviderDriverKind.make("claudeAgent")}
        activeThreadId={threadId}
        timelineEntries={[entry]}
      />,
    );

    try {
      await page.getByRole("button", { name: /^Claude citation worker, Done\./ }).click();
      await vi.waitFor(() => {
        const message = document.querySelector<HTMLElement>(
          '[data-subagent-detail-message="assistant"]',
        );
        expect(message?.textContent).toContain(markerText);
        expect(message?.textContent).not.toContain("Claude literal [1]");
      });
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the snapshot subagent roster while excluding lifecycle rows from historical Work Log", async () => {
    const threadId = ThreadId.make("cafe-thread-historical-subagents");
    const turnId = TurnId.make("cafe-turn-historical-subagents");
    const snapshotEntry = buildSubagentWorkEntry({
      id: "snapshot-historical-worker",
      label: "Historical roster worker",
      subagentId: "historical-child-exact",
      turnId,
      status: "completed",
      updatedAt: "2026-04-13T12:00:20.000Z",
      completedAt: "2026-04-13T12:00:20.000Z",
      description: "Complete snapshot description survives bounded paging",
    }).entry;
    const rawLifecycleActivity = {
      id: EventId.make("raw-historical-subagent-start"),
      sequence: 1,
      turnId,
      createdAt: "2026-04-13T12:00:01.000Z",
      kind: "task.started",
      summary: "Subagent started",
      tone: "info" as const,
      payload: {
        taskId: "historical-child-exact",
        taskType: "subagent",
        detail: "Older partial lifecycle page",
        subagent: {
          threadId: "historical-child-exact",
          label: "Historical roster worker",
          status: "active",
          startedAt: "2026-04-13T12:00:01.000Z",
        },
      },
    };
    const getThreadTurnActivityPage = vi.fn(async (input: { offset: number; limit: number }) => ({
      threadId,
      turnId,
      offset: input.offset,
      limit: input.limit,
      totalCount: 1,
      activities: [rawLifecycleActivity],
    }));
    __setEnvironmentApiOverrideForTests(EnvironmentId.make("environment-local"), {
      orchestration: { getThreadTurnActivityPage },
    } as unknown as EnvironmentApi);
    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        activeThreadId={threadId}
        timelineEntries={[buildAssistantTimelineEntry({ turnId })]}
        historicalWorkLogSummariesByTurnId={
          new Map([
            [
              turnId,
              {
                turnId,
                previewEntries: [],
                snapshotEntryCount: 0,
                subagentEntries: [snapshotEntry],
              },
            ],
          ])
        }
      />,
    );

    try {
      await expect
        .element(
          page.getByText("Complete snapshot description survives bounded paging", {
            exact: true,
          }),
        )
        .toBeVisible();
      await page.getByRole("button", { name: /Work log/ }).click();
      await vi.waitFor(() => expect(getThreadTurnActivityPage).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => {
        expect(document.querySelector("[data-historical-work-log-row]")).toBeNull();
      });
      expect(
        page.getByText("Complete snapshot description survives bounded paging", { exact: true }),
      ).toBeDefined();
      expect(
        document.body.textContent?.match(/Complete snapshot description survives bounded paging/g),
      ).toHaveLength(1);
    } finally {
      await screen.unmount();
    }
  });

  it("closes subagent history when the owning conversation changes without reusing provider ids", async () => {
    const sourceThreadId = ThreadId.make("cafe-thread-detail-source");
    const destinationThreadId = ThreadId.make("cafe-thread-detail-destination");
    const turnId = TurnId.make("cafe-turn-detail-source");
    const getThreadTurnSubagentDetail = vi.fn(async () => ({
      provider: ProviderDriverKind.make("codex"),
      messages: [
        {
          key: "scoped-result",
          role: "assistant" as const,
          text: "Scoped source-thread result.",
        },
      ],
      gaps: [],
      truncated: false,
    }));
    setSubagentDetailApi(getThreadTurnSubagentDetail);

    const sourceEntry = buildSubagentWorkEntry({
      id: "subagent-scoped-detail",
      label: "Scoped detail worker",
      subagentId: "codex-child-scoped-exact",
      turnId,
      status: "completed",
      completedAt: "2026-04-13T12:00:10.000Z",
    });
    const props = buildProps();
    const screen = await render(
      <MessagesTimeline
        {...props}
        activeThreadId={sourceThreadId}
        timelineEntries={[sourceEntry]}
      />,
    );

    try {
      await page.getByRole("button", { name: /^Scoped detail worker, Done\./ }).click();
      await vi.waitFor(() => {
        expect(getThreadTurnSubagentDetail).toHaveBeenCalledTimes(1);
        expect(document.querySelector('[data-subagent-detail-view="true"]')).not.toBeNull();
      });

      await screen.rerender(
        <MessagesTimeline {...props} activeThreadId={destinationThreadId} timelineEntries={[]} />,
      );

      expect(document.querySelector('[data-subagent-detail-view="true"]')).toBeNull();
      await vi.waitFor(() => expect(getThreadTurnSubagentDetail).toHaveBeenCalledTimes(1));
      expect(getThreadTurnSubagentDetail).not.toHaveBeenCalledWith(
        expect.objectContaining({ threadId: destinationThreadId }),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("keeps completed lifecycle detail and frozen timing when provider history is unavailable", async () => {
    const threadId = ThreadId.make("cafe-thread-unavailable-1");
    const turnId = TurnId.make("cafe-turn-unavailable-1");
    const getThreadTurnSubagentDetail = vi.fn(async () => {
      if (getThreadTurnSubagentDetail.mock.calls.length === 1) {
        throw new Error("private provider transport detail");
      }
      return {
        provider: ProviderDriverKind.make("codex"),
        messages: [
          {
            key: "retried-result",
            role: "assistant" as const,
            text: "Recovered bounded transcript",
          },
        ],
        gaps: [],
        truncated: false,
      };
    });
    setSubagentDetailApi(getThreadTurnSubagentDetail);
    const terminalEntry = buildSubagentWorkEntry({
      id: "subagent-unavailable-detail",
      label: "Unavailable history worker",
      subagentId: "codex-child-unavailable-exact",
      turnId,
      status: "completed",
      startedAt: "2026-04-13T12:00:00.000Z",
      completedAt: "2026-04-13T12:00:10.000Z",
      description: "The saved lifecycle progress remains visible",
      objective: "The durable objective remains visible",
    });
    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        activeThreadId={threadId}
        timelineEntries={[terminalEntry]}
      />,
    );

    try {
      await page.getByRole("button", { name: /^Unavailable history worker, Done\./ }).click();
      await vi.waitFor(() => {
        expect(getThreadTurnSubagentDetail).toHaveBeenCalledWith({
          threadId,
          turnId,
          subagentId: "codex-child-unavailable-exact",
        });
        expect(document.querySelector('[data-subagent-detail-unavailable="true"]')).not.toBeNull();
      });

      const detail = document.querySelector<HTMLElement>('[data-subagent-detail-view="true"]');
      expect(detail?.textContent).toContain("The saved lifecycle progress remains visible");
      expect(detail?.textContent).toContain("The durable objective remains visible");
      const elapsed = document.querySelector<HTMLElement>('[data-subagent-detail-elapsed="true"]');
      expect(elapsed?.textContent).toBe("Worked for 10s");
      expect(elapsed?.textContent).toBe("Worked for 10s");
      expect(document.body.textContent).not.toContain("private provider transport detail");

      await page.getByRole("button", { name: "Retry" }).click();
      await expect
        .element(page.getByText("Recovered bounded transcript", { exact: true }))
        .toBeVisible();
      expect(getThreadTurnSubagentDetail).toHaveBeenCalledTimes(2);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps long subagent history internally scrollable without horizontal overflow at 390px", async () => {
    const originalViewport = { height: window.innerHeight, width: window.innerWidth };
    await page.viewport(390, 520);
    const threadId = ThreadId.make("cafe-thread-mobile-1");
    const turnId = TurnId.make("cafe-turn-mobile-1");
    const longMessages = Array.from({ length: 18 }, (_, index) => ({
      key: `message-${index}`,
      role: index === 0 ? ("user" as const) : ("assistant" as const),
      text: `### ${index === 0 ? "Assignment" : `Update ${index}`}\n\n${`Bounded responsive detail ${index} stays readable and wraps inside the chat pane. `.repeat(12)}`,
    }));
    setSubagentDetailApi(async () => ({
      provider: ProviderDriverKind.make("codex"),
      messages: longMessages,
      gaps: [],
      truncated: false,
    }));
    const entry = buildSubagentWorkEntry({
      id: "subagent-mobile-detail",
      label: "Responsive history worker",
      subagentId: "codex-child-mobile-exact",
      turnId,
      status: "active",
      description:
        "A long lifecycle description remains readable while every provider message stays reachable.",
    });
    const host = document.createElement("div");
    Object.assign(host.style, {
      bottom: "0",
      height: "100vh",
      left: "0",
      overflow: "hidden",
      position: "fixed",
      right: "0",
      top: "0",
      width: "100vw",
    });
    document.body.append(host);
    const screen = await render(
      <MessagesTimeline {...buildProps()} activeThreadId={threadId} timelineEntries={[entry]} />,
      { container: host },
    );

    try {
      await page.getByRole("button", { name: /^Responsive history worker, Working\./ }).click();
      await vi.waitFor(() => {
        expect(document.querySelectorAll("[data-subagent-detail-message]")).toHaveLength(
          longMessages.length,
        );
      });

      const detail = document.querySelector<HTMLElement>('[data-subagent-detail-view="true"]');
      const scroller = document.querySelector<HTMLElement>('[data-subagent-detail-scroll="true"]');
      expect(detail).not.toBeNull();
      expect(scroller).not.toBeNull();
      if (!detail || !scroller) throw new Error("Responsive subagent detail did not render");

      expect(getComputedStyle(scroller).overflowY).toBe("auto");
      expect(getComputedStyle(scroller).overflowX).toBe("hidden");
      expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
      const bounds = detail.getBoundingClientRect();
      expect(bounds.left).toBeGreaterThanOrEqual(-1);
      expect(bounds.right).toBeLessThanOrEqual(window.innerWidth + 1);
      expect(bounds.top).toBeGreaterThanOrEqual(-1);
      expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight + 1);

      scroller.scrollTop = scroller.scrollHeight;
      await vi.waitFor(() => expect(scroller.scrollTop).toBeGreaterThan(0));
      const lastMessage = document.querySelector<HTMLElement>(
        '[data-subagent-detail-message="assistant"]:last-of-type',
      );
      expect(lastMessage).not.toBeNull();
      if (lastMessage) {
        const scrollerBounds = scroller.getBoundingClientRect();
        const lastMessageBounds = lastMessage.getBoundingClientRect();
        expect(lastMessageBounds.bottom).toBeLessThanOrEqual(scrollerBounds.bottom + 1);
      }
    } finally {
      await screen.unmount();
      host.remove();
      await page.viewport(originalViewport.width, originalViewport.height);
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

  it("uses data anchoring only while the user is reviewing older content", async () => {
    const props = buildProps();
    const screen = await render(
      <MessagesTimeline
        {...props}
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

      await screen.rerender(
        <MessagesTimeline
          {...props}
          autoFollowTail={false}
          timelineEntries={[buildUserTimelineEntry("existing conversation tail")]}
        />,
      );

      const reviewProps = legendListPropsSpy.mock.calls.at(-1)?.[0] as
        | { maintainVisibleContentPosition?: unknown }
        | undefined;
      expect(reviewProps?.maintainVisibleContentPosition).toEqual({
        data: true,
        size: true,
      });
    } finally {
      await screen.unmount();
    }
  });

  it("repins live row resizes at the tail and cancels that repin on review intent", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

    const props = buildProps();
    const entry = buildUserTimelineEntry("conversation tail before a live tool update");
    const screen = await render(<MessagesTimeline {...props} timelineEntries={[entry]} />);

    try {
      frameCallbacks.length = 0;
      scrollToEndSpy.mockClear();
      scrollToIndexSpy.mockClear();

      const tailProps = legendListPropsSpy.mock.calls.at(-1)?.[0] as
        | {
            onItemSizeChanged?: (info: {
              size: number;
              previous: number;
              index: number;
              itemKey: string;
              itemData: { id: string };
            }) => void;
          }
        | undefined;
      tailProps?.onItemSizeChanged?.({
        size: 180,
        previous: 90,
        index: 0,
        itemKey: entry.id,
        itemData: entry,
      });

      expect(frameCallbacks).toHaveLength(1);
      frameCallbacks.shift()?.(0);
      expect(scrollToEndSpy).toHaveBeenCalledWith({ animated: false });
      expect(scrollToIndexSpy).toHaveBeenCalledWith({
        index: 0,
        animated: false,
        viewPosition: 1,
      });

      scrollToEndSpy.mockClear();
      scrollToIndexSpy.mockClear();
      tailProps?.onItemSizeChanged?.({
        size: 240,
        previous: 180,
        index: 0,
        itemKey: entry.id,
        itemData: entry,
      });
      expect(frameCallbacks).toHaveLength(1);

      const list = document.querySelector("[data-testid='legend-list']");
      list?.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
      frameCallbacks.shift()?.(0);

      expect(props.onUserScrollIntent).toHaveBeenCalled();
      expect(scrollToEndSpy).not.toHaveBeenCalled();
      expect(scrollToIndexSpy).not.toHaveBeenCalled();
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
        | { maintainScrollAtEnd?: boolean; maintainScrollAtEndThreshold?: number }
        | undefined;
      expect(firstProps?.maintainScrollAtEnd).toBe(false);
      expect(firstProps?.maintainScrollAtEndThreshold).toBe(0.01);

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

  it("reports only upward wheel scrolling as review intent", async () => {
    const props = buildProps();
    const screen = await render(
      <MessagesTimeline
        {...props}
        timelineEntries={[buildUserTimelineEntry("keep position when I intentionally scroll")]}
      />,
    );

    try {
      const list = document.querySelector("[data-testid='legend-list']");
      list?.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 120 }));
      expect(props.onUserScrollIntent).not.toHaveBeenCalled();

      list?.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));

      expect(props.onUserScrollIntent).toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("cancels delayed submit pinning when the user starts reviewing output", async () => {
    let nextFrameId = 1;
    const pendingFrames = new Map<number, FrameRequestCallback>();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const frameId = nextFrameId++;
      pendingFrames.set(frameId, callback);
      return frameId;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frameId) => {
      pendingFrames.delete(frameId);
    });
    const flushFrames = () => {
      while (pendingFrames.size > 0) {
        const frames = [...pendingFrames.entries()];
        pendingFrames.clear();
        for (const [, callback] of frames) {
          callback(0);
        }
      }
    };

    const props = buildProps();
    const firstEntry = buildUserTimelineEntry("existing conversation tail");
    const screen = await render(
      <MessagesTimeline {...props} timelineEntries={[firstEntry]} stickToEndRevision={0} />,
    );

    try {
      flushFrames();
      const submittedEntry = {
        ...buildUserTimelineEntry("new prompt whose output is starting"),
        id: "entry-2",
        message: {
          ...buildUserTimelineEntry("new prompt whose output is starting").message,
          id: "message-2" as never,
        },
      };
      await screen.rerender(
        <MessagesTimeline
          {...props}
          timelineEntries={[firstEntry, submittedEntry]}
          stickToEndRevision={1}
        />,
      );

      scrollToEndSpy.mockClear();
      scrollToIndexSpy.mockClear();
      document
        .querySelector("[data-testid='legend-list']")
        ?.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
      flushFrames();

      expect(props.onUserScrollIntent).toHaveBeenCalled();
      expect(scrollToEndSpy).not.toHaveBeenCalled();
      expect(scrollToIndexSpy).not.toHaveBeenCalled();
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
