import "../../index.css";

import { page, userEvent } from "vitest/browser";
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

import type { WorkLogEntry } from "../../session-logic";
import { ComposerTaskProgress, type ComposerTaskProgressPlan } from "./ComposerTaskProgress";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import type { ProviderTasksContext } from "./ProviderTasks";
import type { ScheduledFollowupsContext } from "./ScheduledFollowups";

/** Exact synthetic owner metadata qualifies received rendering, not native
 * provider capacity. No individual task capability or live API is installed. */
function makeOrderedPopupFixture() {
  const environmentId = EnvironmentId.make("ordered-popup-environment");
  const threadId = ThreadId.make("ordered-popup-chat");
  const providerInstanceId = ProviderInstanceId.make("ordered-popup-provider");
  const turnId = TurnId.make("ordered-popup-turn");
  const runtimeId = SubagentRuntimeId.make("40000000-0000-4000-8000-000000000004");
  const workflow: OrchestrationThreadActivity = {
    id: EventId.make("ordered-popup-workflow"),
    sequence: 1,
    kind: "task.started",
    tone: "info",
    summary: "Workflow started",
    turnId,
    createdAt: "2026-10-12T00:00:00.000Z",
    payload: {
      taskId: "ordered-popup-workflow",
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
    id: EventId.make(`ordered-popup-tool-${sequence}`),
    sequence,
    kind,
    tone: "info",
    summary: kind === "tool.updated" ? "Updated command" : "Command run",
    turnId,
    createdAt: "2026-10-12T00:00:01.000Z",
    payload: {
      itemId: "short-lived-command",
      itemType: "command_execution",
      nativeWorkRuntimeId: runtimeId,
      taskOwner:
        kind === "tool.updated" ? { type: "child", id: "ordered-popup-child" } : { type: "root" },
    },
  });
  return { api, providerContext, scheduledContext, tool, workflow };
}

async function mountProgress(
  plan: ComposerTaskProgressPlan | null,
  options?: {
    readonly composerBottom?: boolean;
    readonly subagents?: ReadonlyArray<WorkLogEntry>;
    readonly onOpenSubagentDetail?: (entry: WorkLogEntry, trigger: HTMLButtonElement) => void;
    readonly sessionRailVisible?: boolean;
    readonly onShowOnSide?: () => void;
  },
) {
  const host = document.createElement("div");
  if (options?.composerBottom) {
    host.className = "fixed bottom-2 left-2";
  }
  document.body.append(host);
  const screen = await render(
    <ComposerTaskProgress
      plan={plan}
      {...(options?.subagents ? { subagents: options.subagents } : {})}
      {...(options?.onOpenSubagentDetail
        ? { onOpenSubagentDetail: options.onOpenSubagentDetail }
        : {})}
      {...(options?.sessionRailVisible ? { sessionRailVisible: true } : {})}
      {...(options?.onShowOnSide ? { onShowOnSide: options.onShowOnSide } : {})}
    />,
    { container: host },
  );

  const cleanup = async () => {
    await screen.unmount();
    host.remove();
  };

  return { cleanup, host, screen };
}

const progressTrigger = () =>
  document.querySelector<HTMLButtonElement>('[data-composer-task-progress-trigger="true"]');

const progressPopup = () =>
  document.querySelector<HTMLElement>('[data-composer-task-progress-popup="true"]');

/** Bounding-box comparisons must start after the real finite scale entrance,
 * not midway through its transform. Keep native motion and strict geometry. */
async function settlePopupEntrance(popup: HTMLElement) {
  await Promise.all(
    popup
      .getAnimations({ subtree: true })
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
      .map((animation) => animation.finished),
  );
}

describe("ComposerTaskProgress", () => {
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
    "retains popup section order and the focused schedule draft through task churn in %s at %i%%",
    async (theme, scale) => {
      if (import.meta.env.VITE_PROVIDER_TASK_EXPECT_REDUCED_MOTION === "true")
        expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
      const previousViewport = { width: window.innerWidth, height: window.innerHeight };
      await page.viewport(430, 932);
      document.documentElement.classList.toggle("dark", theme === "dark");
      document.documentElement.style.fontSize = `${scale}%`;
      const { api, providerContext, scheduledContext, tool, workflow } = makeOrderedPopupFixture();
      const onOpenSubagentDetail = vi.fn();
      const onShowOnSide = vi.fn();
      const plan: ComposerTaskProgressPlan = {
        steps: [{ step: "Persistent checklist step", status: "inProgress" }],
      };
      const subagents: WorkLogEntry[] = [
        {
          id: "ordered-popup-child",
          label: "Persistent worker",
          tone: "thinking",
          createdAt: "2026-10-12T00:00:00.000Z",
          subagent: {
            id: "ordered-popup-child",
            label: "Persistent worker",
            status: "active",
            startedAt: "2026-10-12T00:00:00.000Z",
            updatedAt: "2026-10-12T00:00:00.000Z",
          },
        },
      ];
      const renderPopup = (activities: readonly OrchestrationThreadActivity[]) => (
        <div className="fixed bottom-2 left-2">
          <ComposerTaskProgress
            plan={plan}
            subagents={subagents}
            providerTasks={{ ...providerContext, activities }}
            scheduledFollowups={scheduledContext}
            onOpenSubagentDetail={onOpenSubagentDetail}
            onShowOnSide={onShowOnSide}
          />
        </div>
      );
      const screen = await render(renderPopup([workflow]));
      try {
        await page.getByRole("button", { name: /Task progress/ }).click();
        await vi.waitFor(() => expect(progressPopup()).not.toBeNull());
        await expect
          .element(page.getByRole("button", { name: "New follow-up", exact: true }))
          .toBeEnabled();
        const popup = progressPopup()!;
        await settlePopupEntrance(popup);
        const content = popup.querySelector<HTMLElement>("[data-task-list-scroll]")!;
        const retained = [
          page.getByRole("region", { name: "Workflows", exact: true }).element(),
          popup.querySelector<HTMLElement>("[data-composer-subagent-list]")!,
          popup.querySelector<HTMLElement>("[data-composer-task-progress-list]")!,
          popup.querySelector<HTMLElement>("[data-scheduled-followups]")!,
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
          await screen.rerender(renderPopup([workflow, ...received.slice(0, index + 1)]));
          expect(progressPopup()).toBe(popup);
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
            const ownerSlot = currentRow.querySelector<HTMLElement>(
              "[data-provider-task-owner-slot]",
            )!;
            expect(ownerSlot).not.toBeNull();
            expect(ownerSlot.getBoundingClientRect().width).toBeGreaterThan(0);
            if (index === 0) expect(ownerSlot.childElementCount).toBe(0);
            else {
              const ownerIcon = ownerSlot.querySelector<SVGElement>("[data-cafe-subagent-avatar]")!;
              const rosterIcon = popup.querySelector<SVGElement>(
                "[data-composer-subagent-list] [data-cafe-subagent-avatar]",
              )!;
              expect(ownerIcon.innerHTML).toBe(rosterIcon.innerHTML);
              expect(ownerIcon.dataset.palette).toBe(rosterIcon.dataset.palette);
              expect(ownerIcon.dataset.petalShape).toBe(rosterIcon.dataset.petalShape);
              expect(ownerIcon.getAttribute("aria-hidden")).toBe("true");
              expect(ownerIcon.getAttribute("focusable")).toBe("false");
              expect(ownerIcon.getBoundingClientRect().width).toBe(
                ownerSlot.getBoundingClientRect().width,
              );
              expect(currentRow.outerHTML).not.toContain("ordered-popup-child");
            }
            const screenshotDirectory = import.meta.env.VITE_PROVIDER_TASK_SCREENSHOT_DIR;
            if (
              index === 0 &&
              typeof screenshotDirectory === "string" &&
              screenshotDirectory.length > 0
            ) {
              await page.screenshot({
                path: `${screenshotDirectory}/provider-tasks-popup-${theme}-${scale}.png`,
              });
              // Use the existing inner task scroll owner, never the animated
              // outer popover. Restore it before the next lifecycle snapshot.
              const scrollTop = content.scrollTop;
              content.scrollTop = content.scrollHeight;
              expect(ordinary.getBoundingClientRect().bottom).toBeLessThanOrEqual(
                content.getBoundingClientRect().bottom + 1,
              );
              await page.screenshot({
                path: `${screenshotDirectory}/provider-tasks-popup-${theme}-${scale}-bottom.png`,
              });
              content.scrollTop = scrollTop;
            }
          } else {
            expect(content.querySelector('[aria-label="Active provider tasks"]')).toBeNull();
          }
        }
        await page.getByRole("button", { name: "New follow-up", exact: true }).click();
        const name = page.getByLabelText("Name", { exact: true });
        await name.fill("Keep my local draft");
        const nameNode = name.element();
        nameNode.focus();
        for (const activities of [[workflow, received[0]!], [workflow]] as const) {
          await screen.rerender(renderPopup(activities));
          expect(progressPopup()).toBe(popup);
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
          onShowOnSide,
        ])
          expect(action).not.toHaveBeenCalled();
        expect(content.scrollWidth).toBeLessThanOrEqual(content.clientWidth + 1);
        const bounds = popup.getBoundingClientRect();
        expect(bounds.left).toBeGreaterThanOrEqual(0);
        expect(bounds.right).toBeLessThanOrEqual(window.innerWidth + 1);
        expect(bounds.top).toBeGreaterThanOrEqual(0);
        expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight + 1);
        await expect
          .element(page.getByRole("button", { name: "Stop task", exact: true }))
          .not.toBeInTheDocument();
      } finally {
        await screen.unmount();
        await page.viewport(previousViewport.width, previousViewport.height);
      }
    },
  );

  it("keeps Scheduled first and mounted when an otherwise empty popup gains and loses a task", async () => {
    const { api, providerContext, scheduledContext, tool } = makeOrderedPopupFixture();
    const renderPopup = (activities: readonly OrchestrationThreadActivity[]) => (
      <ComposerTaskProgress
        plan={null}
        scheduledFollowups={scheduledContext}
        providerTasks={{ ...providerContext, activities }}
      />
    );
    const screen = await render(renderPopup([]));
    try {
      await page
        .getByRole("button", {
          name: "Tasks and scheduled follow-ups. Show task list",
          exact: true,
        })
        .click();
      await expect
        .element(page.getByRole("button", { name: "New follow-up", exact: true }))
        .toBeEnabled();
      const popup = progressPopup()!;
      await settlePopupEntrance(popup);
      const content = popup.querySelector<HTMLElement>("[data-task-list-scroll]")!;
      const scheduled = content.querySelector<HTMLElement>("[data-scheduled-followups]")!;
      const top = scheduled.getBoundingClientRect().top - content.getBoundingClientRect().top;
      const readCount = api.list.mock.calls.length;
      for (const activities of [[tool(2, "tool.started")], []] as const) {
        await screen.rerender(renderPopup(activities));
        expect(progressPopup()).toBe(popup);
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

  it("keeps ordinary provider-only work inspectable without introducing a Scheduled section", async () => {
    const { providerContext, tool } = makeOrderedPopupFixture();
    const screen = await render(
      <ComposerTaskProgress
        plan={null}
        providerTasks={{ ...providerContext, activities: [tool(2, "tool.started")] }}
      />,
    );
    try {
      const trigger = page.getByRole("button", { name: /1 active task/ });
      await expect.element(trigger).toBeVisible();
      await trigger.click();
      await expect
        .element(page.getByRole("region", { name: "Active provider tasks", exact: true }))
        .toBeVisible();
      expect(progressPopup()?.querySelector("[data-scheduled-followups]")).toBeNull();
      expect(progressPopup()?.querySelector("[data-composer-subagent-list]")).toBeNull();
      expect(progressPopup()?.querySelector("[data-composer-task-progress-list]")).toBeNull();
      expect(progressPopup()?.querySelector('[aria-label="Workflows"]')).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("stays hidden when there is no task plan", async () => {
    const withoutPlan = await mountProgress(null);
    try {
      expect(progressTrigger()).toBeNull();
    } finally {
      await withoutPlan.cleanup();
    }

    const withoutSteps = await mountProgress({ steps: [] });
    try {
      expect(progressTrigger()).toBeNull();
    } finally {
      await withoutSteps.cleanup();
    }
  });

  it("shows step math, ring progress, semantic statuses, and every full task", async () => {
    const plan: ComposerTaskProgressPlan = {
      explanation:
        "Keep the provider's complete explanation visible, including this second line.\nNothing is tooltip-only.",
      steps: [
        {
          step: "Inspect the current task projection without shortening its description.",
          status: "completed",
        },
        {
          step: "Build the responsive composer progress control and show this live task inline.",
          status: "inProgress",
        },
        { step: "Verify the complete interaction and accessibility behavior.", status: "pending" },
      ],
    };
    const mounted = await mountProgress(plan);

    try {
      const trigger = page.getByRole("button", {
        name: "Task progress: step 2 of 3. Show task list",
      });
      await expect.element(trigger).toMatchTextContent("Step 2 / 3");

      const ring = document.querySelector<SVGCircleElement>('[data-task-progress-ring="true"]');
      expect(ring?.dataset.completed).toBe("1");
      expect(ring?.dataset.total).toBe("3");
      expect(Number(ring?.getAttribute("stroke-dashoffset"))).toBeCloseTo(100 - 100 / 3);

      await trigger.click();
      await vi.waitFor(() => expect(progressPopup()).not.toBeNull());

      const popupText = progressPopup()?.textContent ?? "";
      expect(popupText).toContain(plan.explanation);
      for (const step of plan.steps) {
        expect(popupText).toContain(step.step);
      }

      const list = document.querySelector<HTMLOListElement>('ol[aria-label="Task list"]');
      expect(list).not.toBeNull();
      expect(list?.dataset.composerTaskProgressList).toBe("true");
      const rows = Array.from(list?.querySelectorAll<HTMLElement>("li") ?? []);
      expect(rows).toHaveLength(3);
      expect(rows.every((row) => row.dataset.composerTaskProgressStep === "true")).toBe(true);
      expect(rows.map((row) => row.dataset.taskStatus)).toEqual([
        "completed",
        "current",
        "pending",
      ]);
      expect(rows[0]?.textContent).toContain("Completed");
      expect(rows[1]?.textContent).toContain("Current");
      expect(rows[1]?.getAttribute("aria-current")).toBe("step");
      expect(rows[2]?.textContent).toContain("Pending");
    } finally {
      await mounted.cleanup();
    }
  });

  it("supports an agents-only state and opens every live worker from the shared popup", async () => {
    const onOpenSubagentDetail = vi.fn();
    const subagents: WorkLogEntry[] = [
      {
        id: "agent-row-1",
        createdAt: "2026-08-25T10:00:00.000Z",
        label: "Audit Claude history",
        tone: "thinking",
        subagent: {
          id: "provider-child-1",
          label: "Audit Claude history",
          description: "Checking the latest provider update",
          status: "active",
          startedAt: "2026-08-25T10:00:00.000Z",
          updatedAt: "2026-08-25T10:00:05.000Z",
        },
      },
      {
        id: "agent-row-2",
        createdAt: "2026-08-25T10:00:01.000Z",
        label: "Review Codex output",
        tone: "thinking",
        subagent: {
          id: "provider-child-2",
          label: "Review Codex output",
          description: "Waiting for a worker slot",
          status: "waiting",
          startedAt: "2026-08-25T10:00:01.000Z",
          updatedAt: "2026-08-25T10:00:01.000Z",
        },
      },
    ];
    // Historical workers remain available to Atrium, but must not contribute
    // either rows or the current-work trigger count on this Tasks surface.
    for (const status of ["completed", "failed", "stopped", "unknown"] as const) {
      subagents.push({
        id: `historical-${status}`,
        label: `Historical ${status}`,
        tone: "thinking",
        createdAt: "2026-08-25T10:00:00.000Z",
        subagent: {
          id: `historical-${status}`,
          label: `Historical ${status}`,
          status,
          startedAt: "2026-08-25T10:00:00.000Z",
          updatedAt: "2026-08-25T10:00:00.000Z",
        },
      });
    }
    const mounted = await mountProgress(null, { subagents, onOpenSubagentDetail });

    try {
      const trigger = page.getByRole("button", {
        name: "2 active subagents. Show task list",
      });
      await expect.element(trigger).toMatchTextContent("2 agents");
      expect(document.querySelector('[data-task-progress-ring="true"]')).toBeNull();

      await trigger.click();
      await vi.waitFor(() => expect(progressPopup()).not.toBeNull());
      expect(document.querySelectorAll('[data-composer-subagent-list="true"] button')).toHaveLength(
        2,
      );
      expect(progressPopup()?.textContent).not.toContain("Historical");
      await page.getByRole("button", { name: /^Audit Claude history, Working\./ }).click();
      expect(onOpenSubagentDetail).toHaveBeenCalledWith(subagents[0], progressTrigger());
      await vi.waitFor(() => expect(progressPopup()).toBeNull());
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not keep an agents-only Tasks control for a terminal historical roster", async () => {
    const subagents: WorkLogEntry[] = (["completed", "failed", "stopped"] as const).map(
      (status, index) => ({
        id: `historical-${index}`,
        label: "Historical worker",
        tone: "thinking",
        createdAt: "2026-08-25T10:00:00.000Z",
        subagent: {
          id: `historical-${index}`,
          label: "Historical worker",
          status,
          startedAt: "2026-08-25T10:00:00.000Z",
          updatedAt: "2026-08-25T10:00:00.000Z",
        },
      }),
    );
    const mounted = await mountProgress(null, { subagents });
    try {
      expect(progressTrigger()).toBeNull();
      expect(progressPopup()).toBeNull();
      expect(subagents).toHaveLength(3);
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows plan progress and active-agent count together", async () => {
    const mounted = await mountProgress(
      { steps: [{ step: "Implement the shared detail view", status: "inProgress" }] },
      {
        subagents: [
          {
            id: "agent-row",
            createdAt: "2026-08-25T10:00:00.000Z",
            label: "Implement detail",
            tone: "thinking",
            subagent: {
              id: "provider-child",
              label: "Implement detail",
              status: "active",
              startedAt: "2026-08-25T10:00:00.000Z",
              updatedAt: "2026-08-25T10:00:00.000Z",
            },
          },
        ],
      },
    );
    try {
      await expect
        .element(page.getByRole("button", { name: /1 active subagent/ }))
        .toMatchTextContent("Step 1 / 1 · 1 agent");
    } finally {
      await mounted.cleanup();
    }
  });

  it("removes only unsafe invisible controls from provider-authored text", async () => {
    const mounted = await mountProgress({
      explanation: "Explain \u202ethe plan\nwithout truncation.",
      steps: [
        {
          step: "Keep\u0000 every\u2066 printable\u2069 character 👩‍💻.",
          status: "inProgress",
        },
      ],
    });

    try {
      await page.getByRole("button", { name: /Task progress/ }).click();
      await vi.waitFor(() => expect(progressPopup()).not.toBeNull());

      const popupText = progressPopup()?.textContent ?? "";
      expect(popupText).toContain("Explain the plan\nwithout truncation.");
      expect(popupText).toContain("Keep every printable character 👩‍💻.");
      for (const unsafeCodePoint of [0x0000, 0x202e, 0x2066, 0x2069]) {
        expect(popupText).not.toContain(String.fromCodePoint(unsafeCodePoint));
      }
    } finally {
      await mounted.cleanup();
    }
  });

  it("falls back to the first pending step and reaches the final step when complete", async () => {
    const pendingPlan = await mountProgress({
      steps: [
        { step: "Already done", status: "completed" },
        { step: "Waiting now", status: "pending" },
        { step: "Waiting later", status: "pending" },
      ],
    });
    try {
      expect(progressTrigger()?.textContent).toContain("Step 2 / 3");
    } finally {
      await pendingPlan.cleanup();
    }

    const completedPlan = await mountProgress({
      steps: [
        { step: "First complete task", status: "completed" },
        { step: "Second complete task", status: "completed" },
      ],
    });
    try {
      expect(progressTrigger()?.textContent).toContain("Step 2 / 2");
      expect(
        document
          .querySelector<SVGCircleElement>('[data-task-progress-ring="true"]')
          ?.getAttribute("stroke-dashoffset"),
      ).toBe("0");

      await page.getByRole("button", { name: /Task progress/ }).click();
      await vi.waitFor(() => expect(progressPopup()).not.toBeNull());
      const rows = Array.from(
        document.querySelectorAll<HTMLElement>('ol[aria-label="Task list"] > li'),
      );
      expect(rows.map((row) => row.dataset.taskStatus)).toEqual(["completed", "completed"]);
      expect(rows.every((row) => !row.hasAttribute("aria-current"))).toBe(true);
    } finally {
      await completedPlan.cleanup();
    }
  });

  it("opens on hover, click, or keyboard activation and supports dismissal", async () => {
    const mounted = await mountProgress({
      explanation: "Interaction details",
      steps: [{ step: "Exercise every input path", status: "inProgress" }],
    });

    try {
      const trigger = page.getByRole("button", { name: /Task progress/ });

      await trigger.hover();
      await vi.waitFor(() => expect(progressPopup()).not.toBeNull());

      await page.getByRole("region", { name: "Task details" }).hover();
      await new Promise((resolve) => window.setTimeout(resolve, 150));
      expect(progressPopup()).not.toBeNull();

      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => expect(progressPopup()).toBeNull());

      await trigger.click();
      await vi.waitFor(() => expect(progressPopup()).not.toBeNull());
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      document.body.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.waitFor(() => expect(progressPopup()).toBeNull());

      progressTrigger()?.focus();
      expect(document.activeElement).toBe(progressTrigger());
      await userEvent.keyboard("{Enter}");
      await vi.waitFor(() => expect(progressPopup()).not.toBeNull());
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps a long task list scrollable and contained in a narrow viewport", async () => {
    const originalViewport = { height: window.innerHeight, width: window.innerWidth };
    await page.viewport(320, 480);
    const mounted = await mountProgress(
      {
        explanation:
          "The complete explanation remains readable even when the composer is on a narrow screen.",
        steps: Array.from({ length: 24 }, (_, index) => ({
          step: `Task ${index + 1}: a deliberately long description that wraps instead of overflowing the viewport.`,
          status: index === 0 ? ("inProgress" as const) : ("pending" as const),
        })),
      },
      { composerBottom: true },
    );

    try {
      await page.getByRole("button", { name: /Task progress/ }).click();
      await vi.waitFor(() => expect(progressPopup()).not.toBeNull());

      const popup = progressPopup();
      const scrollRegion = document.querySelector<HTMLElement>('[data-task-list-scroll="true"]');
      const outerViewport = popup?.querySelector<HTMLElement>('[data-slot="popover-viewport"]');
      expect(popup).not.toBeNull();
      expect(scrollRegion).not.toBeNull();
      expect(outerViewport).not.toBeNull();
      expect(getComputedStyle(outerViewport!).overflowY).toBe("hidden");
      expect(getComputedStyle(scrollRegion!).overflowY).toBe("auto");
      expect(scrollRegion!.scrollHeight).toBeGreaterThan(scrollRegion!.clientHeight);
      const rows = Array.from(
        document.querySelectorAll<HTMLElement>('ol[aria-label="Task list"] > li'),
      );
      expect(rows).toHaveLength(24);

      scrollRegion!.scrollTop = scrollRegion!.scrollHeight;
      await vi.waitFor(() => {
        const lastRow = rows.at(-1);
        expect(lastRow).toBeTruthy();
        expect(lastRow!.getBoundingClientRect().bottom).toBeLessThanOrEqual(
          scrollRegion!.getBoundingClientRect().bottom + 1,
        );
        expect(lastRow!.getBoundingClientRect().bottom).toBeLessThanOrEqual(
          outerViewport!.getBoundingClientRect().bottom + 1,
        );
        expect(outerViewport!.scrollTop).toBe(0);
      });

      const bounds = popup!.getBoundingClientRect();
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.top).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(window.innerWidth + 1);
      expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight + 1);
    } finally {
      await mounted.cleanup();
      await page.viewport(originalViewport.width, originalViewport.height);
    }
  });

  it("keeps a tall tasks-and-agents popup anchored above the composer pill", async () => {
    const originalViewport = { height: window.innerHeight, width: window.innerWidth };
    await page.viewport(430, 932);
    const subagents: WorkLogEntry[] = Array.from({ length: 3 }, (_, index) => ({
      id: `active-agent-${index + 1}`,
      createdAt: `2026-08-25T10:00:0${index}.000Z`,
      label: `Active audit agent ${index + 1}`,
      tone: "thinking" as const,
      subagent: {
        id: `provider-child-${index + 1}`,
        label: `Active audit agent ${index + 1}`,
        description: "Reviewing the current task boundary",
        status: "active" as const,
        startedAt: `2026-08-25T10:00:0${index}.000Z`,
        updatedAt: `2026-08-25T10:00:1${index}.000Z`,
      },
    }));
    const mounted = await mountProgress(
      {
        explanation:
          "Keep the complete active-agent roster and every task visible inside one scroll region.",
        steps: Array.from({ length: 24 }, (_, index) => ({
          step: `Task ${index + 1}: verify the popup stays attached to its composer trigger.`,
          status: index === 0 ? ("inProgress" as const) : ("pending" as const),
        })),
      },
      { composerBottom: true, subagents },
    );

    try {
      await page.getByRole("button", { name: /Task progress/ }).hover();
      await vi.waitFor(() => expect(progressPopup()).not.toBeNull());

      const trigger = progressTrigger();
      const popup = progressPopup();
      const positioner = popup?.closest<HTMLElement>('[data-slot="popover-positioner"]');
      expect(trigger).not.toBeNull();
      expect(popup).not.toBeNull();
      expect(positioner).not.toBeNull();
      if (!trigger || !popup || !positioner) {
        throw new Error("Anchored task progress popup did not finish mounting.");
      }

      const triggerBounds = trigger.getBoundingClientRect();
      const popupBounds = popup.getBoundingClientRect();
      expect(positioner.dataset.side).toBe("top");
      expect(triggerBounds.top - popupBounds.bottom).toBeCloseTo(8, 0);
      // Fractional device-pixel snapping can move the aligned edges by slightly
      // more than one CSS pixel even though the popup remains visually flush.
      expect(Math.abs(popupBounds.left - triggerBounds.left)).toBeLessThanOrEqual(2);
    } finally {
      await mounted.cleanup();
      await page.viewport(originalViewport.width, originalViewport.height);
    }
  });

  it("closes the task popup when docking and opens with one press after undocking", async () => {
    const onShowOnSide = vi.fn();
    const plan: ComposerTaskProgressPlan = {
      steps: [{ step: "Keep the live pill after docking", status: "inProgress" }],
    };
    const dockable = await mountProgress(plan, { onShowOnSide });

    try {
      await page.getByRole("button", { name: /Task progress/ }).click();
      await vi.waitFor(() => expect(progressPopup()).not.toBeNull());
      await page.getByRole("button", { name: "Show on the side" }).click();
      expect(onShowOnSide).toHaveBeenCalledTimes(1);

      // Keep the same component mounted across the placement change: returning
      // null while docked must not preserve the old press-open state and reopen
      // its popup when the composer pill returns.
      await dockable.screen.rerender(
        <ComposerTaskProgress plan={plan} sessionRailVisible onShowOnSide={onShowOnSide} />,
      );
      expect(progressTrigger()).toBeNull();
      expect(progressPopup()).toBeNull();
      expect(document.querySelector('[data-session-rail-dock="true"]')).toBeNull();

      await dockable.screen.rerender(
        <ComposerTaskProgress plan={plan} sessionRailVisible={false} onShowOnSide={onShowOnSide} />,
      );
      const trigger = page.getByRole("button", { name: /Task progress/ });
      await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
      expect(progressPopup()).toBeNull();

      await trigger.click();
      await vi.waitFor(() => expect(progressPopup()).not.toBeNull());
      await expect.element(trigger).toHaveAttribute("aria-expanded", "true");
    } finally {
      await dockable.cleanup();
    }
  });
});
