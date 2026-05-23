import { EnvironmentId, MessageId } from "@cafecode/contracts";
import { createRef, type ReactNode, type Ref } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { LegendListRef } from "@legendapp/list/react";

vi.mock("@legendapp/list/react", async () => {
  const legendListTestId = "legend-list";

  const LegendList = (props: {
    data: Array<{ id: string }>;
    keyExtractor: (item: { id: string }) => string;
    renderItem: (args: { item: { id: string } }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
    ref?: Ref<LegendListRef>;
  }) => (
    <div data-testid={legendListTestId}>
      {props.ListHeaderComponent}
      {props.data.map((item) => (
        <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
      ))}
      {props.ListFooterComponent}
    </div>
  );

  return { LegendList };
});

function matchMedia() {
  return {
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

beforeAll(() => {
  const classList = {
    add: () => {},
    remove: () => {},
    toggle: () => {},
    contains: () => false,
  };

  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  });
  vi.stubGlobal("window", {
    matchMedia,
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    cancelAnimationFrame: () => {},
    desktopBridge: undefined,
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList,
      offsetHeight: 0,
    },
  });
});

const ACTIVE_THREAD_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const MESSAGE_CREATED_AT = "2026-03-17T19:12:28.000Z";

function buildProps() {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    activeTurnId: null,
    activeTurnStartedAt: null,
    listRef: createRef<LegendListRef | null>(),
    completionDividerBeforeEntryId: null,
    completionSummary: null,
    revertTurnCountByUserMessageId: new Map(),
    onRevertUserMessage: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ACTIVE_THREAD_ENVIRONMENT_ID,
    markdownCwd: undefined,
    timestampFormat: "locale" as const,
    workspaceRoot: undefined,
    onIsAtEndChange: () => {},
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
      id: MessageId.make("message-1"),
      role: "user" as const,
      text,
      createdAt: MESSAGE_CREATED_AT,
      streaming: false,
    },
  };
}

function buildAssistantTimelineEntry(text: string, options?: { streaming?: boolean }) {
  return {
    id: "assistant-entry-1",
    kind: "message" as const,
    createdAt: MESSAGE_CREATED_AT,
    message: {
      id: MessageId.make("assistant-message-1"),
      role: "assistant" as const,
      text,
      createdAt: MESSAGE_CREATED_AT,
      completedAt: options?.streaming ? undefined : "2026-03-17T19:13:16.000Z",
      streaming: options?.streaming ?? false,
      turnId: "turn-1" as never,
    },
  };
}

describe("MessagesTimeline file open helpers", () => {
  it("treats near-bottom scroll positions as already at the end", async () => {
    const { isTimelineScrolledToEnd } = await import("./MessagesTimeline");

    expect(isTimelineScrolledToEnd({ isAtEnd: true })).toBe(true);
    expect(
      isTimelineScrolledToEnd({
        isAtEnd: false,
        contentLength: 2_000,
        scroll: 1_420,
        scrollLength: 500,
      }),
    ).toBe(true);
    expect(
      isTimelineScrolledToEnd({
        isAtEnd: false,
        contentLength: 2_000,
        scroll: 1_300,
        scrollLength: 500,
      }),
    ).toBe(false);
    expect(isTimelineScrolledToEnd({ isAtEnd: false })).toBe(false);
  });

  it("uses the configured editor only when that editor is available", async () => {
    const { resolveFileOpenEditor } = await import("./MessagesTimeline");

    expect(resolveFileOpenEditor("system-default", ["vscode"])).toBeNull();
    expect(resolveFileOpenEditor("vscode", ["vscode", "antigravity"])).toBe("vscode");
    expect(resolveFileOpenEditor("vscode", ["antigravity"])).toBeNull();
  });

  it("extracts openable command path tokens inside the workspace", async () => {
    const { extractOpenablePathTokens } = await import("./MessagesTimeline");

    expect(
      extractOpenablePathTokens(
        "sed -n '1,40p' /Users/mike/work/app/src/main.ts ../secret.txt README.md",
        "/Users/mike/work/app",
      ),
    ).toEqual(["/Users/mike/work/app/src/main.ts"]);
  });
});

describe("MessagesTimeline", () => {
  it("renders collapse controls for long user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
      />,
    );

    expect(markup).toContain("Show full message");
    expect(markup).toContain('data-user-message-collapsed="true"');
    expect(markup).toContain('data-user-message-fade="true"');
    expect(markup).toContain('data-user-message-footer="true"');
  });

  it("does not render collapse controls for short user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry("Short prompt.")]}
      />,
    );

    expect(markup).not.toContain("Show full message");
    expect(markup).toContain('data-user-message-collapsible="false"');
  });

  it("keeps the copy button for collapsed long user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
      />,
    );

    expect(markup).toContain('aria-label="Copy link"');
    expect(markup).toContain('data-user-message-collapsed="true"');
    expect(markup).toContain('data-user-message-footer="true"');
  });

  it("renders the copy button for completed assistant output", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildAssistantTimelineEntry("Assistant token output.")]}
      />,
    );

    expect(markup).toContain('aria-label="Copy link"');
    expect(markup).toContain("Assistant token output.");
  });

  it("keeps the assistant copy button while output is still streaming", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        activeTurnInProgress
        activeTurnId={"turn-1" as never}
        timelineEntries={[
          buildAssistantTimelineEntry("Partial assistant output.", { streaming: true }),
        ]}
      />,
    );

    expect(markup).toContain('aria-label="Copy link"');
    expect(markup).toContain("Partial assistant output.");
  });

  it("renders context compaction entries in the normal work log", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Context compacted",
              tone: "info",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Context compacted");
    expect(markup).toContain("Work log");
  });

  it("formats changed file paths from the workspace root", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Updated files",
              tone: "tool",
              detail: "Applied patch",
              changedFiles: ["C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts"],
            },
          },
        ]}
        workspaceRoot="C:/Users/mike/dev-stuff/t3code"
      />,
    );

    expect(markup).toContain("t3code/apps/web/src/session-logic.ts");
    expect(markup).not.toContain("C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts");
    expect(markup).toContain('data-work-log-path-pill="changed-file"');
    expect(markup).toContain("text-left");
  });

  it("left-aligns openable path pills from runtime warning details", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "runtime-warning",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Runtime warning",
              tone: "info",
              detail: "Reconnecting... cafe-code/2/5",
            },
          },
        ]}
        workspaceRoot="/Users/mike/selia"
      />,
    );

    expect(markup).toContain("Runtime warning");
    expect(markup).toContain('data-work-log-path-pill="command-token"');
    expect(markup).toContain("text-left");
  });

  it("does not expose truncated JSON fragments as openable path tokens", async () => {
    const { extractOpenablePathTokens } = await import("./MessagesTimeline");

    expect(
      extractOpenablePathTokens(
        'Write: {"file_path":"/Users/mike/selia/selia/.selene/adrs/0110-deferred-coverage…',
        "/Users/mike/selia",
      ),
    ).toEqual([]);
    expect(
      extractOpenablePathTokens(
        "git add /Users/mike/selia/.../0110-deferred-coverage.md",
        "/Users/mike/selia",
      ),
    ).toEqual([]);
    expect(
      extractOpenablePathTokens(
        "git add /Users/mike/selia/selia/.selene/adrs/0110-deferred-coverage.md",
        "/Users/mike/selia",
      ),
    ).toEqual(["/Users/mike/selia/selia/.selene/adrs/0110-deferred-coverage.md"]);
  });
});
