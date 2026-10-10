import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import {
  EnvironmentId,
  EventId,
  ProviderInstanceId,
  SubagentRuntimeId,
  ThreadId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@cafecode/contracts";

import { deriveLatestContextWindowSnapshot } from "../../lib/contextWindow";
import { deriveActiveSubagentWorkEntries, type WorkLogEntry } from "../../session-logic";
import type { SubagentRuntimeContext } from "../../subagent-activity";
import { CodexRecoveryNotice, SessionRail } from "./SessionRail";
import type { ComposerTaskProgressPlan } from "./taskProgressPresentation";

function makeUsage() {
  return deriveLatestContextWindowSnapshot([
    {
      id: EventId.make("activity-context-window"),
      tone: "info",
      kind: "context-window.updated",
      summary: "Context window updated",
      payload: {
        usedTokens: 213_000,
        maxTokens: 258_000,
        totalProcessedTokens: 6_600_000,
        compactsAutomatically: true,
      },
      turnId: TurnId.make("turn-1"),
      createdAt: "2026-08-25T10:00:00.000Z",
    },
  ]);
}

describe("SessionRail", () => {
  afterEach(() => {
    document.documentElement.classList.remove("dark");
    document.body.innerHTML = "";
  });

  it.each(["light", "dark"])(
    "shows compact truthful recovery with independent Stop in %s",
    async (theme) => {
      document.documentElement.classList.toggle("dark", theme === "dark");
      const previousViewport = { width: window.innerWidth, height: window.innerHeight };
      await page.viewport(414, 700);
      const onStop = vi.fn();
      const view = await render(
        <div style={{ width: 260 }}>
          <CodexRecoveryNotice
            presentation={{ activeAgentCount: 2, stage: "backoff", retryAtMs: Date.now() + 60_000 }}
            onStop={onStop}
          />
        </div>,
      );
      try {
        const notice = document.querySelector<HTMLElement>('[data-codex-recovery-notice="true"]')!;
        await expect.element(page.getByRole("status")).toMatchTextContent("Root failed");
        await expect.element(page.getByRole("status")).toMatchTextContent(/Retry in \d+s/u);
        await expect.element(page.getByRole("status")).toMatchTextContent("2 agents active");
        const stop = page.getByRole("button", {
          name: "Stop recovery and running agents",
          exact: true,
        });
        await expect.element(stop).toBeEnabled();
        const buttonBounds = stop.element().getBoundingClientRect();
        const noticeBounds = notice.getBoundingClientRect();
        expect(buttonBounds.right).toBeLessThanOrEqual(noticeBounds.right);
        await stop.click();
        expect(onStop).toHaveBeenCalledOnce();
        await view.rerender(
          <div style={{ width: 260 }}>
            <CodexRecoveryNotice
              presentation={{ activeAgentCount: 2, stage: "backoff", retryAtMs: Date.now() - 1 }}
              onStop={onStop}
              disabled
            />
          </div>,
        );
        await expect.element(page.getByRole("status")).toMatchTextContent("Reconnecting");
        await expect.element(stop).toBeDisabled();
        expect(document.body.textContent).not.toContain("Running root");
        await view.rerender(
          <div style={{ width: 260 }}>
            <CodexRecoveryNotice
              presentation={{ activeAgentCount: 0, stage: "uncertain", retryAtMs: null }}
              onStop={onStop}
            />
          </div>,
        );
        await expect.element(page.getByRole("status")).toMatchTextContent("Needs reconciliation");
        await expect.element(stop).toBeEnabled();
        expect(document.body.textContent).not.toContain("Retry in");
      } finally {
        await view.unmount();
        await page.viewport(previousViewport.width, previousViewport.height);
      }
    },
  );

  it("keeps a workflow-only Tasks rail available without inventing an active subagent or ordinary controls", async () => {
    const providerInstanceId = ProviderInstanceId.make("claude-workflow");
    const runtimeId = SubagentRuntimeId.make("10000000-0000-4000-8000-000000000001");
    const screen = await render(
      <SessionRail
        plan={null}
        subagents={[]}
        usage={null}
        onShowInComposer={vi.fn()}
        providerTasks={{
          environmentId: EnvironmentId.make("local"),
          threadId: ThreadId.make("workflow-parent"),
          providerInstanceId,
          runtimeSession: { orchestrationStatus: "running", subagentRuntimeId: runtimeId },
          activities: [
            {
              id: EventId.make("workflow-rail-start"),
              kind: "task.started",
              tone: "info",
              summary: "Workflow started",
              turnId: TurnId.make("workflow-turn"),
              createdAt: "2026-10-09T00:00:00.000Z",
              payload: {
                taskId: "workflow-root",
                workflow: { runtimeId, providerInstanceId, name: "Review workflow" },
              },
            },
          ],
        }}
      />,
    );
    try {
      await expect
        .element(page.getByRole("region", { name: "Workflows", exact: true }))
        .toBeVisible();
      await expect
        .element(page.getByText("No tasks yet.", { exact: true }))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByText("Phase details unavailable.", { exact: true }))
        .toBeVisible();
      expect(document.querySelector('[data-composer-subagent-list="true"]')).toBeNull();
      await expect
        .element(page.getByRole("button", { name: "Stop task", exact: true }))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("counts only current workers and clears terminal rows without deleting historical input", async () => {
    const history: WorkLogEntry[] = (
      ["active", "waiting", "completed", "failed", "stopped", "unknown"] as const
    ).map((status) => ({
      id: `rail-${status}`,
      label: `Rail worker ${status}`,
      tone: "thinking",
      createdAt: "2020-01-01T00:00:00.000Z",
      subagent: {
        id: `rail-${status}`,
        label: `Rail worker ${status}`,
        status,
        startedAt: "2020-01-01T00:00:00.000Z",
        updatedAt: "2020-01-01T00:00:00.000Z",
      },
    }));
    const onShowInComposer = vi.fn();
    const screen = await render(
      <SessionRail
        plan={null}
        subagents={history}
        usage={null}
        onShowInComposer={onShowInComposer}
      />,
    );
    try {
      await expect.element(page.getByText("2 active", { exact: true })).toBeVisible();
      expect(document.querySelectorAll('[data-composer-subagent-list="true"] button')).toHaveLength(
        2,
      );
      for (const status of ["completed", "failed", "stopped", "unknown"])
        expect(document.body.textContent).not.toContain(`Rail worker ${status}`);
      await screen.rerender(
        <SessionRail
          plan={null}
          subagents={history.map((entry) =>
            entry.subagent
              ? { ...entry, subagent: { ...entry.subagent, status: "completed" as const } }
              : entry,
          )}
          usage={null}
          onShowInComposer={onShowInComposer}
        />,
      );
      await expect.element(page.getByText("No tasks yet.", { exact: true })).toBeVisible();
      expect(document.querySelector('[data-composer-subagent-list="true"]')).toBeNull();
      expect(history.map((entry) => entry.subagent?.status)).toEqual([
        "active",
        "waiting",
        "completed",
        "failed",
        "stopped",
        "unknown",
      ]);
    } finally {
      await screen.unmount();
    }
  });

  it("shows exact surviving workers after root failure and withdraws unverified runtime evidence", async () => {
    const rootTurn = TurnId.make("failed-root-turn");
    const runtimeId = SubagentRuntimeId.make("20000000-0000-4000-8000-000000000002");
    const rows: OrchestrationThreadActivity[] = [
      {
        id: EventId.make("surviving-child-progress"),
        kind: "task.progress",
        tone: "info",
        summary: "Subagent update",
        turnId: rootTurn,
        createdAt: "2026-10-10T00:00:00.000Z",
        payload: {
          taskId: "surviving-child",
          subagent: {
            threadId: "surviving-child",
            label: "Surviving worker",
            status: "active",
            runtimeId,
          },
        },
      },
    ];
    const snapshot = structuredClone(rows);
    const currentRuntime = {
      orchestrationStatus: "ready" as const,
      subagentRuntimeId: runtimeId,
      lastError: "Synthetic failed root request.",
    };
    const rail = (runtimeSession: SubagentRuntimeContext | null) => (
      <SessionRail
        plan={null}
        subagents={deriveActiveSubagentWorkEntries(rows, null, { runtimeSession })}
        usage={null}
        onShowInComposer={vi.fn()}
      />
    );
    const screen = await render(rail(currentRuntime));
    try {
      await expect.element(page.getByText("1 active", { exact: true })).toBeVisible();
      await expect.element(page.getByText("Surviving worker", { exact: true })).toBeVisible();
      await expect
        .element(page.getByText("No tasks yet.", { exact: true }))
        .not.toBeInTheDocument();

      // A saved failure is not runtime death, but stopped, legacy error,
      // replacement and unknown contexts still cannot supply live child proof.
      for (const unavailable of [
        { ...currentRuntime, orchestrationStatus: "stopped" as const },
        { ...currentRuntime, orchestrationStatus: "error" as const },
        { ...currentRuntime, subagentRuntimeId: "replacement-native-context" },
        null,
      ]) {
        await screen.rerender(rail(unavailable));
        await expect.element(page.getByText("No tasks yet.", { exact: true })).toBeVisible();
        expect(document.querySelector('[data-composer-subagent-list="true"]')).toBeNull();
      }
      expect(rows).toEqual(snapshot);
    } finally {
      await screen.unmount();
    }
  });

  it("pins usage under the complete task list and can return to the composer", async () => {
    document.documentElement.style.setProperty("--primary", "#dc2626");
    const onShowInComposer = vi.fn();
    const onOpenSubagentDetail = vi.fn();
    const plan: ComposerTaskProgressPlan = {
      explanation: "Keep every step visible in the docked rail.",
      steps: [
        { step: "Audit the current binding", status: "inProgress" },
        { step: "Remove the static approval", status: "pending" },
        { step: "Publish the patch", status: "pending" },
      ],
    };
    const subagents: WorkLogEntry[] = [
      {
        id: "agent-row",
        createdAt: "2026-08-25T10:00:00.000Z",
        label: "Audit Claude history",
        tone: "thinking",
        subagent: {
          id: "provider-child",
          label: "Audit Claude history",
          description: "Checking the latest provider update",
          status: "active",
          startedAt: "2026-08-25T10:00:00.000Z",
          updatedAt: "2026-08-25T10:00:05.000Z",
        },
      },
    ];
    const host = document.createElement("div");
    host.style.height = "640px";
    document.body.append(host);
    const screen = await render(
      <SessionRail
        plan={plan}
        subagents={subagents}
        usage={makeUsage()}
        rateLimits={{
          checkedAt: "2026-08-25T10:00:00.000Z",
          rateLimits: {
            limitId: "codex",
            primary: {
              usedPercent: 1,
              windowDurationMins: 10_080,
              resetsAt: 1_788_278_880,
            },
          },
        }}
        onShowInComposer={onShowInComposer}
        onOpenSubagentDetail={onOpenSubagentDetail}
      />,
      { container: host },
    );

    try {
      const rail = document.querySelector<HTMLElement>('[data-session-rail="true"]');
      const tasks = document.querySelector<HTMLElement>('[data-session-rail-tasks="true"]');
      const usage = document.querySelector<HTMLElement>('[data-session-rail-usage="true"]');
      expect(rail).not.toBeNull();
      expect(tasks).not.toBeNull();
      expect(usage).not.toBeNull();
      expect(rail?.textContent).toContain("0 of 3 completed");
      expect(rail?.textContent).toContain("Audit the current binding");
      expect(rail?.textContent).toContain("Remove the static approval");
      expect(rail?.textContent).toContain("Publish the patch");
      expect(rail?.textContent).toContain("Audit Claude history");
      expect(usage?.textContent).toContain("213k");
      expect(usage?.textContent).toContain("258k");
      expect(usage?.textContent).toContain("6.6m");
      expect(usage?.textContent).toContain("Primary window");
      expect(usage?.textContent).toContain("99% left");
      const contextBar = usage?.querySelector<HTMLElement>(
        '[data-session-rail-usage-bar="context"]',
      );
      const primaryBar = usage?.querySelector<HTMLElement>(
        '[data-session-rail-usage-bar="primary-window"]',
      );
      expect(contextBar).not.toBeNull();
      expect(primaryBar).not.toBeNull();
      expect(getComputedStyle(contextBar?.firstElementChild as HTMLElement).backgroundColor).toBe(
        "rgb(220, 38, 38)",
      );
      expect(getComputedStyle(primaryBar?.firstElementChild as HTMLElement).backgroundColor).toBe(
        "rgb(220, 38, 38)",
      );
      expect((primaryBar?.firstElementChild as HTMLElement | null)?.style.width).toBe("99%");

      await page.getByRole("button", { name: "Show in composer" }).click();
      expect(onShowInComposer).toHaveBeenCalledTimes(1);

      await page.getByRole("button", { name: /^Audit Claude history, Working\./ }).click();
      expect(onOpenSubagentDetail).toHaveBeenCalledTimes(1);
    } finally {
      document.documentElement.style.removeProperty("--primary");
      await screen.unmount();
      host.remove();
    }
  });

  it("keeps the rail visible with an empty checklist", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <SessionRail plan={null} usage={null} onShowInComposer={vi.fn()} />,
      { container: host },
    );

    try {
      expect(document.querySelector('[data-session-rail="true"]')?.textContent).toContain(
        "No tasks yet.",
      );
      expect(document.querySelector('[data-session-rail-usage="true"]')?.textContent).toContain(
        "Waiting for usage from this chat.",
      );
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("keeps many quota buckets scrollable inside a short rail with reset availability below them", async () => {
    await page.viewport(1100, 800);
    const host = document.createElement("div");
    host.style.cssText =
      "display:flex; flex-direction:column; width:280px; height:280px; overflow:hidden";
    document.body.append(host);
    const screen = await render(
      <SessionRail
        plan={{ steps: [{ step: "Still visible task", status: "inProgress" }] }}
        usage={makeUsage()}
        rateLimits={{
          checkedAt: "2026-09-29T00:00:00.000Z",
          rateLimits: {},
          rateLimitsByLimitId: Object.fromEntries(
            Array.from({ length: 8 }, (_, index) => [
              `quota-${index}`,
              {
                limitName: `Quota ${index}`,
                primary: { usedPercent: index, windowDurationMins: 300, resetsAt: 1_788_278_880 },
                credits: { hasCredits: true, unlimited: false, balance: "25" },
              },
            ]),
          ),
          rateLimitResetCredits: { availableCount: 2 },
        }}
        onShowInComposer={vi.fn()}
      />,
      { container: host },
    );
    try {
      const rail = host.querySelector<HTMLElement>("[data-session-rail]")!;
      const usage = host.querySelector<HTMLElement>("[data-session-rail-usage]")!;
      const quotaScroll = host.querySelector<HTMLElement>("[data-account-quota-scroll]")!;
      const count = page.getByText("Usage limit resets available: 2", { exact: true }).element();
      expect(usage.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        rail.getBoundingClientRect().bottom + 1,
      );
      expect(count.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        rail.getBoundingClientRect().bottom,
      );
      expect(quotaScroll.clientHeight).toBeGreaterThan(0);
      expect(quotaScroll.scrollHeight).toBeGreaterThan(quotaScroll.clientHeight);
      expect(quotaScroll.contains(count)).toBe(false);
      const countTop = count.getBoundingClientRect().top;
      quotaScroll.scrollTop = quotaScroll.scrollHeight;
      expect(count.getBoundingClientRect().top).toBe(countTop);
      expect(host.querySelectorAll("[data-account-quota-bucket]")).toHaveLength(8);
      expect(getComputedStyle(quotaScroll).overflowY).toBe("auto");
      expect(host.scrollHeight).toBeLessThanOrEqual(host.clientHeight + 1);
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
