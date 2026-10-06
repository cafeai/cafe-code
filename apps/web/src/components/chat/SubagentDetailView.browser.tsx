import "../../index.css";
import {
  EnvironmentId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  type EnvironmentApi,
} from "@cafecode/contracts";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { SubagentDetailView, type SubagentDetailSelection } from "./SubagentDetailView";

// Existing transcript browser tests qualify Markdown itself. Keep these tests
// focused on the authenticated activity projection and keyed detail lifetime.
vi.mock("../ChatMarkdown", () => ({ default: ({ text }: { text: string }) => <p>{text}</p> }));

type Detail = Awaited<ReturnType<EnvironmentApi["orchestration"]["getThreadTurnSubagentDetail"]>>;
const environmentId = EnvironmentId.make("subagent-activity-environment");
const threadId = ThreadId.make("subagent-activity-parent");
const turnId = TurnId.make("subagent-activity-turn");
const timestamp = "2026-10-07T00:00:00.000Z";

function selection(historyId = "history-a", revision = "one"): SubagentDetailSelection {
  return {
    environmentId,
    threadId,
    rowId: "worker-row",
    turnId,
    workEntry: {
      id: "worker-row",
      createdAt: timestamp,
      label: "Worker",
      tone: "info",
      subagent: {
        id: "child-worker",
        historyId,
        label: "Worker",
        status: "completed",
        startedAt: timestamp,
        completedAt: timestamp,
        lifecycleRevision: revision,
        objective: "Inspect the requested source",
      },
    },
  };
}

function DetailFixture({
  selected = selection(),
  width = 540,
}: {
  selected?: SubagentDetailSelection;
  width?: number;
}) {
  return (
    <div className="relative h-[420px]" style={{ width }}>
      <SubagentDetailView
        selection={selected}
        environmentId={environmentId}
        threadId={threadId}
        provider={ProviderDriverKind.make("codex")}
        markdownCwd={undefined}
        additionalWorkspaceRoots={[]}
        skills={[]}
        backButtonRef={createRef<HTMLButtonElement>()}
        onBack={vi.fn()}
      />
    </div>
  );
}

function installRead(read: EnvironmentApi["orchestration"]["getThreadTurnSubagentDetail"]) {
  __setEnvironmentApiOverrideForTests(environmentId, {
    orchestration: { getThreadTurnSubagentDetail: read },
  } as unknown as EnvironmentApi);
}

afterEach(() => {
  __resetEnvironmentApiOverridesForTests();
});

describe("subagent activity detail", () => {
  it("shows admitted file paths and commands as readable text beside their activity category", async () => {
    const command = "rg -n 'subagent' apps/web/src";
    const readPath = "apps/web/src/components/chat/SubagentDetailView.tsx";
    const editPath = "apps/web/src/components/chat/SubagentDetailView.browser.tsx";
    installRead(async () => ({
      provider: ProviderDriverKind.make("codex"),
      messages: [],
      gaps: [],
      truncated: false,
      activities: [
        { key: "a1", kind: "command", timestamp, detail: command },
        { key: "a2", kind: "file_read", detail: readPath },
        { key: "a3", kind: "file_edit", detail: editPath },
      ],
    }));
    const view = await render(<DetailFixture />);
    try {
      await expect.element(page.getByText(command, { exact: true })).toBeVisible();
      await expect.element(page.getByText(readPath, { exact: true })).toBeVisible();
      await expect.element(page.getByText(editPath, { exact: true })).toBeVisible();
      const rows = Array.from(document.querySelectorAll("[data-subagent-detail-activity]"));
      expect(rows.map((row) => row.querySelector("span")?.textContent)).toEqual([
        "Command",
        "File read",
        "File edit",
      ]);
      expect(rows[0]?.querySelector("time")?.getAttribute("datetime")).toBe(timestamp);
      expect(rows.flatMap((row) => Array.from(row.querySelectorAll("a,button")))).toEqual([]);
    } finally {
      await view.unmount();
    }
  });

  it("keeps long hostile-looking details literal, fully available, and within the detail pane", async () => {
    // Exercise the admitted single-line 512-byte limit, including one long
    // token. These strings are display data, never HTML or link instructions.
    const detail = (
      '<script>alert("not executed")</script> <img src="invalid" onerror="alert(1)"> ' +
      "[open](javascript:alert(1)) https://example.invalid/"
    ).padEnd(512, "x");
    installRead(async () => ({
      provider: ProviderDriverKind.make("claudeAgent"),
      messages: [],
      gaps: [],
      truncated: false,
      activities: [{ key: "a1", kind: "command", detail }],
    }));
    const view = await render(<DetailFixture width={320} />);
    try {
      await vi.waitFor(() =>
        expect(document.querySelector("[data-subagent-detail-activity-detail]")?.textContent).toBe(
          detail,
        ),
      );
      const row = document.querySelector<HTMLElement>("[data-subagent-detail-activity]")!;
      const detailNode = row.querySelector<HTMLElement>("[data-subagent-detail-activity-detail]")!;
      const scroller = document.querySelector<HTMLElement>("[data-subagent-detail-scroll]")!;
      expect(row.querySelector("script,img,a,button,iframe")).toBeNull();
      expect(detailNode.textContent).toBe(detail);
      expect(getComputedStyle(detailNode).whiteSpace).toBe("pre-wrap");
      expect(getComputedStyle(detailNode).overflowWrap).toBe("anywhere");
      expect(detailNode.scrollWidth).toBeLessThanOrEqual(detailNode.clientWidth + 1);
      expect(scroller.scrollWidth).toBeLessThanOrEqual(scroller.clientWidth + 1);
    } finally {
      await view.unmount();
    }
  });

  it("shows fixed activity categories and bounded-history disclosure without raw tool fields", async () => {
    const activities = [
      { key: "a1", kind: "command" as const, timestamp, args: "PRIVATE_COMMAND" },
      { key: "a2", kind: "file_read" as const, path: "PRIVATE_PATH" },
      { key: "a3", kind: "file_edit" as const, result: "PRIVATE_RESULT" },
      { key: "a4", kind: "agent_message" as const, recipient: "PRIVATE_RECIPIENT" },
      { key: "a5", kind: "tool" as const, title: "PRIVATE_TITLE", reasoning: "PRIVATE_REASONING" },
    ];
    const read = vi.fn(async () => ({
      provider: ProviderDriverKind.make("codex"),
      messages: [],
      gaps: [],
      truncated: false,
      activities,
      activityHistoryIncomplete: true,
    }));
    installRead(read);
    const view = await render(<DetailFixture />);
    try {
      await expect
        .element(page.getByRole("region", { name: "Subagent activity", exact: true }))
        .toBeVisible();
      const rows = Array.from(document.querySelectorAll("[data-subagent-detail-activity]"));
      expect(rows.map((row) => row.getAttribute("data-subagent-detail-activity"))).toEqual([
        "command",
        "file_read",
        "file_edit",
        "agent_message",
        "tool",
      ]);
      expect(rows.map((row) => row.querySelector("span")?.textContent)).toEqual([
        "Command",
        "File read",
        "File edit",
        "Agent message",
        "Tool use",
      ]);
      expect(rows[0]?.querySelector("time")?.getAttribute("datetime")).toBe(timestamp);
      expect(document.querySelector("[data-subagent-detail-activity-detail]")).toBeNull();
      expect(document.body.textContent).not.toContain("PRIVATE_");
      expect(document.body.textContent).not.toContain("No public subagent messages were saved");
      await expect
        .element(
          page.getByText(
            "Showing recent activity. Earlier activity is outside this view’s retrieval limit.",
          ),
        )
        .toBeVisible();
      expect(read).toHaveBeenCalledWith({
        threadId,
        turnId,
        subagentId: "child-worker",
        historyId: "history-a",
      });
    } finally {
      await view.unmount();
    }
  });

  it("preserves legacy public transcripts when activity data is absent", async () => {
    installRead(async () => ({
      provider: ProviderDriverKind.make("claudeAgent"),
      messages: [{ key: "m1", role: "assistant", text: "The public result remains visible." }],
      gaps: [],
      truncated: false,
    }));
    const view = await render(<DetailFixture />);
    try {
      await expect
        .element(page.getByText("The public result remains visible.", { exact: true }))
        .toBeVisible();
      expect(document.querySelector("[data-subagent-detail-activity]")).toBeNull();
      expect(document.querySelector("[data-subagent-detail-activity-incomplete]")).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it("counts activity-only refreshes while preserving a reader's scroll position", async () => {
    let count = 80;
    installRead(async () => ({
      provider: ProviderDriverKind.make("codex"),
      messages: [{ key: "m1", role: "assistant", text: "Unchanged public update" }],
      gaps: [],
      truncated: false,
      activities: Array.from({ length: count }, (_, index) => ({
        key: `a${index.toString(36)}`,
        kind: "tool" as const,
      })),
    }));
    const view = await render(<DetailFixture />);
    try {
      await vi.waitFor(() =>
        expect(document.querySelectorAll("[data-subagent-detail-activity]")).toHaveLength(80),
      );
      const scroller = document.querySelector<HTMLDivElement>("[data-subagent-detail-scroll]")!;
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      count = 81;
      await view.rerender(<DetailFixture selected={selection("history-a", "two")} />);
      await vi.waitFor(() =>
        expect(document.querySelectorAll("[data-subagent-detail-activity]")).toHaveLength(81),
      );
      expect(scroller.scrollTop).toBe(0);
      await expect
        .element(page.getByRole("button", { name: "1 new update · Jump to latest" }))
        .toBeVisible();
    } finally {
      await view.unmount();
    }
  });

  it("counts changed detail on the same activity without moving a reader away from older content", async () => {
    let detail = "src/before.ts";
    installRead(async () => ({
      provider: ProviderDriverKind.make("codex"),
      messages: [],
      gaps: [],
      truncated: false,
      activities: Array.from({ length: 80 }, (_, index) => ({
        key: `a${index.toString(36)}`,
        kind: "file_read" as const,
        detail: index === 79 ? detail : `src/unchanged-${index}.ts`,
      })),
    }));
    const view = await render(<DetailFixture />);
    try {
      await expect.element(page.getByText("src/before.ts", { exact: true })).toBeVisible();
      const scroller = document.querySelector<HTMLDivElement>("[data-subagent-detail-scroll]")!;
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      detail = "src/after.ts";
      await view.rerender(<DetailFixture selected={selection("history-a", "two")} />);
      await expect.element(page.getByText("src/after.ts", { exact: true })).toBeInTheDocument();
      expect(document.querySelectorAll("[data-subagent-detail-activity]")).toHaveLength(80);
      expect(scroller.scrollTop).toBe(0);
      await expect
        .element(page.getByRole("button", { name: "1 new update · Jump to latest" }))
        .toBeVisible();
    } finally {
      await view.unmount();
    }
  });

  it("clears activity immediately when the same worker row selects a different history", async () => {
    let resolveReplacement!: (value: Detail) => void;
    const replacement = new Promise<Detail>((resolve) => {
      resolveReplacement = resolve;
    });
    installRead(async (request) =>
      request.historyId === "history-b"
        ? replacement
        : {
            provider: ProviderDriverKind.make("codex"),
            messages: [],
            gaps: [],
            truncated: false,
            activities: [{ key: "a1", kind: "command", detail: "rg old-history src" }],
          },
    );
    const view = await render(<DetailFixture />);
    try {
      await expect.element(page.getByText("Command", { exact: true })).toBeVisible();
      await view.rerender(<DetailFixture selected={selection("history-b")} />);
      expect(document.querySelector("[data-subagent-detail-activity]")).toBeNull();
      expect(document.body.textContent).not.toContain("rg old-history src");
      resolveReplacement({
        provider: ProviderDriverKind.make("claudeAgent"),
        messages: [],
        gaps: [],
        truncated: false,
        activities: [{ key: "a2", kind: "file_edit", detail: "src/replacement-history.ts" }],
      });
      await expect.element(page.getByText("File edit", { exact: true })).toBeVisible();
      await expect
        .element(page.getByText("src/replacement-history.ts", { exact: true }))
        .toBeVisible();
      expect(document.querySelector('[data-subagent-detail-activity="command"]')).toBeNull();
    } finally {
      await view.unmount();
    }
  });
});
