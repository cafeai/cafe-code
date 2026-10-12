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
  type EnvironmentApi,
  type OrchestrationThreadActivity,
} from "@cafecode/contracts";

import { deriveLatestContextWindowSnapshot } from "../../lib/contextWindow";
import { deriveActiveSubagentWorkEntries, type WorkLogEntry } from "../../session-logic";
import type { SubagentRuntimeContext } from "../../subagent-activity";
import { CodexRecoveryNotice, SessionRail } from "./SessionRail";
import type { ComposerTaskProgressPlan } from "./taskProgressPresentation";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import type { ProviderTasksContext } from "./ProviderTasks";
import type { ScheduledFollowupsContext } from "./ScheduledFollowups";

/** This fixture is received renderer data only. No task capability is minted,
 * so layout churn cannot gain Stop/background authority or contact a provider. */
function makeOrderedRailFixture() {
  const environmentId = EnvironmentId.make("ordered-rail-environment");
  const threadId = ThreadId.make("ordered-rail-chat");
  const providerInstanceId = ProviderInstanceId.make("ordered-rail-provider");
  const turnId = TurnId.make("ordered-rail-turn");
  const runtimeId = SubagentRuntimeId.make("30000000-0000-4000-8000-000000000003");
  const workflow: OrchestrationThreadActivity = {
    id: EventId.make("ordered-rail-workflow"),
    sequence: 1,
    kind: "task.started",
    tone: "info",
    summary: "Workflow started",
    turnId,
    createdAt: "2026-10-12T00:00:00.000Z",
    payload: {
      taskId: "ordered-rail-workflow",
      workflow: { runtimeId, providerInstanceId, name: "Persistent workflow" },
    },
  };
  const providerContext: ProviderTasksContext = {
    environmentId,
    threadId,
    providerInstanceId,
    runtimeSession: { orchestrationStatus: "running", subagentRuntimeId: runtimeId },
    activeTurnId: turnId,
    activeTurnRunning: true,
    activities: [workflow],
  };
  const scheduledContext: ScheduledFollowupsContext = {
    environmentId,
    threadId,
    modelSelection: { instanceId: providerInstanceId, model: "fixture-model" },
    provider: null,
    unavailable: false,
  };
  const api = {
    list: vi.fn(async () => ({ schedules: [], backendOnline: true as const })),
    save: vi.fn(async () => {
      throw new Error("Unexpected synthetic schedule mutation");
    }),
    setStatus: vi.fn(async () => {
      throw new Error("Unexpected synthetic schedule mutation");
    }),
    runNow: vi.fn(async () => {
      throw new Error("Unexpected synthetic schedule mutation");
    }),
    history: vi.fn(async () => ({ runs: [], nextCursor: null })),
    notification: vi.fn(async () => ({ notify: true })),
  };
  __setEnvironmentApiOverrideForTests(environmentId, {
    scheduledFollowups: api,
  } as unknown as EnvironmentApi);
  const tool = (
    sequence: number,
    kind: "tool.started" | "tool.updated" | "tool.completed",
  ): OrchestrationThreadActivity => ({
    id: EventId.make(`ordered-rail-tool-${sequence}`),
    sequence,
    kind,
    tone: "info",
    summary: kind === "tool.updated" ? "Updated command" : "Command run",
    turnId,
    createdAt: "2026-10-12T00:00:01.000Z",
    payload: { itemId: "short-lived-command", itemType: "command_execution" },
  });
  return { api, providerContext, scheduledContext, tool, workflow };
}

/** Finish only the real finite entrance animation before comparing geometry.
 * Looping status indicators are not disabled or awaited. */
async function settleRailEntrance(rail: HTMLElement) {
  await Promise.all(
    rail
      .getAnimations({ subtree: true })
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
      .map((animation) => animation.finished),
  );
}

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
    __resetEnvironmentApiOverridesForTests();
    document.documentElement.classList.remove("dark");
    document.documentElement.style.removeProperty("font-size");
    document.body.innerHTML = "";
  });

  it.each([
    ["light", 80],
    ["light", 130],
    ["dark", 80],
    ["dark", 130],
  ] as const)(
    "keeps every retained section stationary above transient provider tasks in %s at %i%%",
    async (theme, scale) => {
      if (import.meta.env.VITE_PROVIDER_TASK_EXPECT_REDUCED_MOTION === "true")
        expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
      const previousViewport = { width: window.innerWidth, height: window.innerHeight };
      await page.viewport(430, 932);
      document.documentElement.classList.toggle("dark", theme === "dark");
      document.documentElement.style.fontSize = `${scale}%`;
      const { api, providerContext, scheduledContext, tool, workflow } = makeOrderedRailFixture();
      const onOpenSubagentDetail = vi.fn();
      const onStopRecovery = vi.fn();
      const onShowInComposer = vi.fn();
      const subagents: WorkLogEntry[] = [
        {
          id: "ordered-rail-child",
          label: "Persistent worker",
          tone: "thinking",
          createdAt: "2026-10-12T00:00:00.000Z",
          subagent: {
            id: "ordered-rail-child",
            label: "Persistent worker",
            status: "active",
            startedAt: "2026-10-12T00:00:00.000Z",
            updatedAt: "2026-10-12T00:00:00.000Z",
          },
        },
      ];
      const plan: ComposerTaskProgressPlan = {
        steps: [{ step: "Persistent checklist step", status: "inProgress" }],
      };
      const renderRail = (activities: readonly OrchestrationThreadActivity[]) => (
        <div style={{ display: "flex", width: 280, height: 820 }}>
          <SessionRail
            plan={plan}
            subagents={subagents}
            usage={null}
            providerTasks={{ ...providerContext, activities }}
            scheduledFollowups={scheduledContext}
            codexRecovery={{ activeAgentCount: 1, stage: "uncertain", retryAtMs: null }}
            onStopCodexRecovery={onStopRecovery}
            onOpenSubagentDetail={onOpenSubagentDetail}
            onShowInComposer={onShowInComposer}
          />
        </div>
      );
      const screen = await render(renderRail([workflow]));
      try {
        await expect
          .element(page.getByRole("button", { name: "New follow-up", exact: true }))
          .toBeEnabled();
        const rail = document.querySelector<HTMLElement>("[data-session-rail]")!;
        await settleRailEntrance(rail);
        const content = rail.querySelector<HTMLElement>("[data-session-rail-tasks]")!;
        const retained = [
          rail.querySelector<HTMLElement>("[data-codex-recovery-notice]")!,
          page.getByRole("region", { name: "Workflows", exact: true }).element(),
          rail.querySelector<HTMLElement>("[data-composer-subagent-list]")!,
          rail.querySelector<HTMLElement>("[data-composer-task-progress-list]")!,
          rail.querySelector<HTMLElement>("[data-scheduled-followups]")!,
        ];
        const relativeTops = retained.map(
          (node) => node.getBoundingClientRect().top - content.getBoundingClientRect().top,
        );
        const newFollowup = page
          .getByRole("button", { name: "New follow-up", exact: true })
          .element();
        newFollowup.focus();
        const readCount = api.list.mock.calls.length;
        const received = [
          tool(2, "tool.started"),
          tool(3, "tool.updated"),
          tool(4, "tool.completed"),
        ];
        let taskRow: HTMLElement | null = null;
        for (let index = 0; index < received.length; index += 1) {
          await screen.rerender(renderRail([workflow, ...received.slice(0, index + 1)]));
          for (const [position, node] of retained.entries()) {
            expect(node.isConnected).toBe(true);
            expect(
              node.getBoundingClientRect().top - content.getBoundingClientRect().top,
            ).toBeCloseTo(relativeTops[position]!, 1);
            if (position > 0)
              expect(
                retained[position - 1]!.compareDocumentPosition(node) &
                  Node.DOCUMENT_POSITION_FOLLOWING,
              ).toBeTruthy();
          }
          expect(document.activeElement).toBe(newFollowup);
          if (index < 2) {
            const ordinary = page
              .getByRole("region", { name: "Active provider tasks", exact: true })
              .element();
            expect(
              retained.at(-1)!.compareDocumentPosition(ordinary) & Node.DOCUMENT_POSITION_FOLLOWING,
            ).toBeTruthy();
            expect(content.lastElementChild).toBe(ordinary);
            expect(ordinary.querySelectorAll("[data-provider-task-row]")).toHaveLength(1);
            const currentRow = ordinary.querySelector<HTMLElement>("[data-provider-task-row]")!;
            if (index === 0) taskRow = currentRow;
            else expect(currentRow).toBe(taskRow);
            expect(currentRow.querySelector("[data-provider-task-title]")?.textContent).toBe(
              index === 0 ? "Command run" : "Updated command",
            );
            const screenshotDirectory = import.meta.env.VITE_PROVIDER_TASK_SCREENSHOT_DIR;
            if (
              index === 0 &&
              typeof screenshotDirectory === "string" &&
              screenshotDirectory.length > 0
            ) {
              await page.screenshot({
                path: `${screenshotDirectory}/provider-tasks-rail-${theme}-${scale}.png`,
              });
              // This deliberately narrow rail can need its real task scroll
              // owner at large interface size. Capture the bottom separately,
              // then restore review position before the next received update.
              const scrollOwner = content.closest<HTMLElement>(
                '[data-slot="scroll-area-viewport"]',
              )!;
              const scrollTop = scrollOwner.scrollTop;
              scrollOwner.scrollTop = scrollOwner.scrollHeight;
              expect(ordinary.getBoundingClientRect().bottom).toBeLessThanOrEqual(
                scrollOwner.getBoundingClientRect().bottom + 1,
              );
              await page.screenshot({
                path: `${screenshotDirectory}/provider-tasks-rail-${theme}-${scale}-bottom.png`,
              });
              scrollOwner.scrollTop = scrollTop;
            }
          } else {
            expect(content.querySelector('[aria-label="Active provider tasks"]')).toBeNull();
          }
        }
        // A schedule editor is local state. Short-lived native rows must not
        // remount it, erase the draft, steal focus or dispatch a schedule action.
        await page.getByRole("button", { name: "New follow-up", exact: true }).click();
        const name = page.getByLabelText("Name", { exact: true });
        await name.fill("Keep my local draft");
        const nameNode = name.element();
        nameNode.focus();
        for (const activities of [[workflow, received[0]!], [workflow]] as const) {
          await screen.rerender(renderRail(activities));
          expect(page.getByLabelText("Name", { exact: true }).element()).toBe(nameNode);
          await expect.element(name).toHaveValue("Keep my local draft");
          expect(document.activeElement).toBe(nameNode);
        }
        expect(api.list).toHaveBeenCalledTimes(readCount);
        for (const action of [
          api.save,
          api.setStatus,
          api.runNow,
          api.history,
          api.notification,
          onOpenSubagentDetail,
          onStopRecovery,
          onShowInComposer,
        ])
          expect(action).not.toHaveBeenCalled();
        expect(content.scrollWidth).toBeLessThanOrEqual(content.clientWidth + 1);
        expect(rail.querySelector("[data-session-rail-usage]")).not.toBeNull();
        await expect
          .element(page.getByRole("button", { name: "Stop task", exact: true }))
          .not.toBeInTheDocument();
      } finally {
        await screen.unmount();
        await page.viewport(previousViewport.width, previousViewport.height);
      }
    },
  );

  it("keeps Scheduled first and stationary when an otherwise empty rail gains and loses a task", async () => {
    const { api, providerContext, scheduledContext, tool } = makeOrderedRailFixture();
    const renderRail = (activities: readonly OrchestrationThreadActivity[]) => (
      <div style={{ display: "flex", width: 280, height: 700 }}>
        <SessionRail
          plan={null}
          usage={null}
          onShowInComposer={vi.fn()}
          scheduledFollowups={scheduledContext}
          providerTasks={{ ...providerContext, activities }}
        />
      </div>
    );
    const screen = await render(renderRail([]));
    try {
      await expect
        .element(page.getByRole("button", { name: "New follow-up", exact: true }))
        .toBeEnabled();
      const rail = document.querySelector<HTMLElement>("[data-session-rail]")!;
      await settleRailEntrance(rail);
      const content = rail.querySelector<HTMLElement>("[data-session-rail-tasks]")!;
      const scheduled = content.querySelector<HTMLElement>("[data-scheduled-followups]")!;
      const top = scheduled.getBoundingClientRect().top - content.getBoundingClientRect().top;
      const readCount = api.list.mock.calls.length;
      for (const activities of [[tool(2, "tool.started")], []] as const) {
        await screen.rerender(renderRail(activities));
        expect(content.firstElementChild).toBe(scheduled);
        expect(scheduled.isConnected).toBe(true);
        expect(
          scheduled.getBoundingClientRect().top - content.getBoundingClientRect().top,
        ).toBeCloseTo(top, 1);
        expect(content.textContent).not.toContain("No tasks yet.");
        if (activities.length)
          expect(content.lastElementChild?.getAttribute("aria-label")).toBe(
            "Active provider tasks",
          );
        else expect(content.children).toHaveLength(1);
      }
      expect(api.list).toHaveBeenCalledTimes(readCount);
      for (const action of [api.save, api.setStatus, api.runNow])
        expect(action).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
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
            presentation={{
              activeAgentCount: 2,
              stage: "backoff",
              retryAtMs: Date.now() + 60_000,
              continuationOrdinal: 37,
              continuationOrdinalLowerBound: true,
            }}
            onStop={onStop}
          />
        </div>,
      );
      try {
        const notice = document.querySelector<HTMLElement>('[data-codex-recovery-notice="true"]')!;
        await expect.element(page.getByRole("status")).toMatchTextContent("Reconnecting");
        await expect.element(page.getByRole("status")).toMatchTextContent(/Retry #37\+ in \d+s/u);
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
              presentation={{
                activeAgentCount: 2,
                stage: "backoff",
                retryAtMs: Date.now() - 1,
                continuationOrdinal: 38,
              }}
              onStop={onStop}
              disabled
            />
          </div>,
        );
        await expect.element(page.getByRole("status")).toMatchTextContent("Reconnecting");
        await expect.element(page.getByRole("status")).toMatchTextContent("Retry #38");
        expect(document.body.textContent).not.toContain("in 0s");
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
        await view.rerender(
          <div style={{ width: 260 }}>
            <CodexRecoveryNotice
              presentation={{ activeAgentCount: 2, stage: null, retryAtMs: null }}
              onStop={onStop}
            />
          </div>,
        );
        await expect
          .element(page.getByRole("status"))
          .toHaveTextContent("Agents running · 2 agents active");
        await expect.element(stop).toBeEnabled();
        expect(document.body.textContent).not.toContain("Reconnecting");
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

  it("keeps ordinary provider-only work below the empty checklist without inventing schedules", async () => {
    const { providerContext, tool } = makeOrderedRailFixture();
    const screen = await render(
      <SessionRail
        plan={null}
        usage={null}
        onShowInComposer={vi.fn()}
        providerTasks={{ ...providerContext, activities: [tool(2, "tool.started")] }}
      />,
    );
    try {
      await expect
        .element(page.getByRole("region", { name: "Active provider tasks", exact: true }))
        .toBeVisible();
      const content = document.querySelector<HTMLElement>("[data-session-rail-tasks]")!;
      expect(content.querySelector("[data-scheduled-followups]")).toBeNull();
      expect(content.querySelector("[data-composer-subagent-list]")).toBeNull();
      expect(content.querySelector("[data-composer-task-progress-list]")).toBeNull();
      expect(content.querySelector('[aria-label="Workflows"]')).toBeNull();
      expect(content.textContent).not.toContain("No tasks yet.");
      expect(content.children).toHaveLength(1);
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
