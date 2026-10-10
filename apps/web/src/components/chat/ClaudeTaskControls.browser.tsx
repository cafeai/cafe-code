import "../../index.css";
import { useState } from "react";
import {
  EnvironmentId,
  EventId,
  ProviderInstanceId,
  SubagentRuntimeId,
  ThreadId,
  TurnId,
  type ProviderDeliveryPriority,
  type OrchestrationThreadActivity,
  type RuntimeWorkflowPresentation,
} from "@cafecode/contracts";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeDeliveryPriorityPicker } from "./ClaudeDeliveryPriorityPicker";
import { SubagentTaskControls } from "./SubagentTaskControls";
import { ProviderTasks, type ProviderTasksContext } from "./ProviderTasks";
import type { WorkLogEntry } from "../../session-logic";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";

const { controlTask } = vi.hoisted(() => ({ controlTask: vi.fn() }));
vi.mock("../../environmentApi", () => ({
  readEnvironmentApi: () => ({ orchestration: { controlTask } }),
}));
const environmentId = EnvironmentId.make("local");
const threadId = ThreadId.make("parent");
const turnId = TurnId.make("turn");
const subagent: NonNullable<WorkLogEntry["subagent"]> = {
  id: "native-task",
  label: "Worker",
  status: "active",
  startedAt: "2026-10-05T00:00:00Z",
  runtimeId: "10000000-0000-4000-8000-000000000001",
  taskControl: {
    providerInstanceId: ProviderInstanceId.make("account-a"),
    taskGeneration: "00000000-0000-4000-8000-000000000001",
    canStop: true,
    canBackground: true,
  },
};
const workflow: RuntimeWorkflowPresentation = {
  runtimeId: SubagentRuntimeId.make(subagent.runtimeId!),
  providerInstanceId: ProviderInstanceId.make("account-a"),
  name: "Review requested implementation",
  phases: [
    { index: 1, title: "Explore implementation", kind: "parallel" },
    { index: 2, title: "Review boundaries" },
  ],
  agents: [
    {
      index: 1,
      phaseIndex: 1,
      label: "Inspect UI",
      model: "claude-opus-4-8",
      fallbackModel: "claude-sonnet-4-8",
      status: "completed",
      totalTokens: 1234,
      durationMs: 2400,
    },
    { index: 2, phaseIndex: 2, label: "Review account binding", status: "running" },
    { index: 3, label: "Unassigned review", status: "pending" },
  ],
};
function workflowActivity(
  sequence: number,
  kind: string,
  payload: Record<string, unknown> = {},
): OrchestrationThreadActivity {
  return {
    id: EventId.make(`workflow-${sequence}`),
    kind,
    sequence,
    tone: "info",
    summary: "Workflow activity",
    turnId,
    createdAt: `2026-10-09T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    payload: { taskId: "workflow-root", workflow, ...payload },
  };
}
const workflowStart = workflowActivity(1, "task.started", {
  taskType: "local_workflow",
  detail: "Review the change and report concrete findings",
  individualTaskControl: {
    runtimeId: workflow.runtimeId,
    taskId: "workflow-root",
    capability: { ...subagent.taskControl!, canBackground: false },
  },
});
function workflowContext(
  activities: readonly OrchestrationThreadActivity[] = [workflowStart],
): ProviderTasksContext {
  return {
    environmentId,
    threadId,
    providerInstanceId: workflow.providerInstanceId,
    runtimeSession: { orchestrationStatus: "running", subagentRuntimeId: workflow.runtimeId },
    activities,
  };
}
function PriorityHarness() {
  const [priority, setPriority] = useState<ProviderDeliveryPriority | undefined>();
  return (
    <Menu>
      <MenuTrigger>More composer controls</MenuTrigger>
      <MenuPopup>
        <ClaudeDeliveryPriorityPicker value={priority} onChange={setPriority} disabled={false} />
      </MenuPopup>
    </Menu>
  );
}
afterEach(() => vi.clearAllMocks());
describe("Claude priority and exact task controls", () => {
  it("renders received workflow phases and inert agents while controlling only the exact root", async () => {
    controlTask.mockResolvedValue({ status: "accepted" });
    const view = await render(<ProviderTasks context={workflowContext()} />);
    await expect
      .element(page.getByRole("region", { name: "Workflows", exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByRole("region", { name: "Active provider tasks" }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("article", { name: "Workflow: Review requested implementation" }))
      .toBeVisible();
    await expect
      .element(page.getByText("Review the change and report concrete findings", { exact: true }))
      .toBeVisible();
    await expect.element(page.getByText("2 phases · 3 agents", { exact: true })).toBeVisible();
    await expect.element(page.getByText("1/1 reported agents done", { exact: true })).toBeVisible();
    await expect.element(page.getByText("0/1 reported agents done", { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("region", { name: "Phase 1: Explore implementation" }))
      .toBeVisible();
    await expect
      .element(page.getByText("claude-opus-4-8 · Fallback: claude-sonnet-4-8", { exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByText(`${new Intl.NumberFormat().format(1234)} tokens`, { exact: true }))
      .toBeVisible();
    await expect.element(page.getByText("2s", { exact: true })).toBeVisible();
    expect(document.querySelectorAll("[data-workflow-agent-row]")).toHaveLength(3);
    expect(
      document.querySelectorAll("[data-workflow-agent-row] button, [data-workflow-agent-row] a"),
    ).toHaveLength(0);
    expect(document.querySelectorAll("[data-workflow-agent-model]")[1]?.textContent).toBe(
      "Model unavailable",
    );
    expect(document.querySelectorAll("[data-workflow-agent-usage]")[1]?.textContent).toBe(
      "Tokens unavailableDuration unavailable",
    );
    const telemetry = page.getByRole("button", { name: "About workflow telemetry" });
    telemetry.element().focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(telemetry).toHaveAttribute("aria-describedby");
    await expect
      .element(page.getByText(/Model, tokens, duration and status are reported by Claude\./))
      .toBeVisible();
    expect(
      document.getElementById(telemetry.element().getAttribute("aria-describedby")!)?.textContent,
    ).toContain("token counts are not billing totals");
    await userEvent.keyboard("{Escape}");
    await page.getByRole("button", { name: "Stop task", exact: true }).click();
    expect(controlTask).toHaveBeenCalledExactlyOnceWith({
      threadId,
      turnId,
      providerInstanceId: "account-a",
      runtimeId: workflow.runtimeId,
      taskId: "workflow-root",
      taskGeneration: subagent.taskControl!.taskGeneration,
      action: "stop",
    });
    const done = workflowActivity(2, "task.completed", {
      status: "completed",
      workflow: { runtimeId: workflow.runtimeId, providerInstanceId: workflow.providerInstanceId },
      usage: { total_tokens: 1500, duration_ms: 5000 },
    });
    await view.rerender(<ProviderTasks context={workflowContext([workflowStart, done])} />);
    await expect
      .element(page.getByRole("button", { name: "Stop task", exact: true }))
      .not.toBeInTheDocument();
    await expect.element(page.getByText("5s", { exact: true })).toBeVisible();
    // Root completion is not evidence that every snapshot agent completed.
    expect(document.querySelectorAll("[data-workflow-agent-status]")[1]?.textContent).toBe(
      "Status unavailable",
    );
    expect(document.querySelectorAll("[data-workflow-agent-status]")[0]?.textContent).toBe("Done");
    // A completed root cannot turn an unreported/running child's phase into
    // complete; counts describe only the explicitly received child statuses.
    await expect.element(page.getByText("0/1 reported agents done", { exact: true })).toBeVisible();
    const delayed = workflowActivity(3, "task.progress", {
      usage: { total_tokens: 9999, duration_ms: 9999 },
    });
    await view.rerender(
      <ProviderTasks context={workflowContext([workflowStart, done, delayed])} />,
    );
    await expect.element(page.getByText("5s", { exact: true })).toBeVisible();
    await expect
      .element(page.getByText(`${new Intl.NumberFormat().format(9999)} tokens`, { exact: true }))
      .not.toBeInTheDocument();
  });

  it("updates one received snapshot and preserves unavailable detail instead of inferring phases", async () => {
    const noSnapshot = {
      ...workflowStart,
      payload: {
        ...(workflowStart.payload as Record<string, unknown>),
        workflow: {
          runtimeId: workflow.runtimeId,
          providerInstanceId: workflow.providerInstanceId,
          name: workflow.name,
        },
        individualTaskControl: undefined,
      },
    };
    const view = await render(<ProviderTasks context={workflowContext([noSnapshot])} />);
    await expect
      .element(page.getByText("Phase details unavailable.", { exact: true }))
      .toBeVisible();
    const supplied = workflowActivity(2, "task.progress", {
      detail: "Exploring",
      usage: { total_tokens: 100, duration_ms: 2000 },
    });
    await view.rerender(<ProviderTasks context={workflowContext([noSnapshot, supplied])} />);
    expect(document.querySelectorAll("[data-workflow-task-card]")).toHaveLength(1);
    expect(document.querySelectorAll("[data-workflow-agent-row]")).toHaveLength(3);
    const omitted = workflowActivity(3, "task.progress", {
      workflow: { runtimeId: workflow.runtimeId, providerInstanceId: workflow.providerInstanceId },
    });
    await view.rerender(
      <ProviderTasks context={workflowContext([noSnapshot, supplied, omitted])} />,
    );
    expect(document.querySelectorAll("[data-workflow-agent-row]")).toHaveLength(3);
    const replacement = workflowActivity(4, "task.progress", {
      workflow: {
        ...workflow,
        phases: [{ index: 2, title: "Final review" }],
        agents: [{ index: 2, phaseIndex: 2, label: "Review complete", status: "completed" }],
      },
    });
    await view.rerender(
      <ProviderTasks context={workflowContext([noSnapshot, supplied, omitted, replacement])} />,
    );
    expect(document.querySelectorAll("[data-workflow-agent-row]")).toHaveLength(1);
    await expect.element(page.getByText("1 phase · 1 agent", { exact: true })).toBeVisible();
    const mixed = workflowActivity(5, "task.progress", {
      workflow: {
        ...workflow,
        phases: [{ index: 2, title: "Final review" }],
        agents: [
          { index: 2, phaseIndex: 2, status: "completed" },
          { index: 4, phaseIndex: 2, status: "failed" },
          { index: 5, phaseIndex: 2 },
        ],
      },
    });
    await view.rerender(
      <ProviderTasks context={workflowContext([noSnapshot, supplied, replacement, mixed])} />,
    );
    await expect.element(page.getByText("1/3 reported agents done", { exact: true })).toBeVisible();
    const emptied = workflowActivity(6, "task.progress", {
      workflow: { ...workflow, phases: [], agents: [], truncated: true },
    });
    await view.rerender(
      <ProviderTasks context={workflowContext([noSnapshot, supplied, emptied])} />,
    );
    await expect
      .element(page.getByText("No phase activity reported.", { exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByText("Some workflow details were omitted.", { exact: true }))
      .toBeVisible();
    await view.rerender(
      <ProviderTasks
        context={{
          ...workflowContext([workflowStart]),
          providerInstanceId: ProviderInstanceId.make("other-account"),
        }}
      />,
    );
    await expect
      .element(page.getByRole("region", { name: "Workflows", exact: true }))
      .not.toBeInTheDocument();
  });

  it("pages workflow roots without rendering snapshot children as additional tasks", async () => {
    const activities = Array.from({ length: 7 }, (_, index) =>
      workflowActivity(index + 1, "task.started", {
        taskId: `workflow-root-${index}`,
        workflow: { ...workflow, name: `Workflow review ${index}` },
      }),
    );
    const view = await render(<ProviderTasks context={workflowContext(activities)} />);
    expect(document.querySelectorAll("[data-workflow-task-card]")).toHaveLength(5);
    expect(document.querySelectorAll("[data-workflow-agent-row]")).toHaveLength(15);
    await expect
      .element(page.getByRole("button", { name: "Previous workflow page" }))
      .toBeDisabled();
    await expect
      .element(page.getByText("Workflow review 0", { exact: true }))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: "Next workflow page" }).click();
    expect(document.querySelectorAll("[data-workflow-task-card]")).toHaveLength(2);
    await expect.element(page.getByText("Workflow review 0", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Next workflow page" })).toBeDisabled();
    await view.rerender(<ProviderTasks context={workflowContext([activities[0]!])} />);
    await expect.element(page.getByText("Workflow review 0", { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("navigation", { name: "Workflow pages" }))
      .not.toBeInTheDocument();
  });

  for (const [width, dark, scale] of [
    [430, true, "130%"],
    [960, false, "80%"],
  ] as const) {
    it(`contains long inert workflow copy at ${width}px and ${scale}`, async () => {
      const originalViewport = { width: window.innerWidth, height: window.innerHeight };
      const previousFontSize = document.documentElement.style.fontSize;
      const wasDark = document.documentElement.classList.contains("dark");
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.style.fontSize = scale;
      await page.viewport(width + 24, 900);
      const longWorkflow = workflowActivity(1, "task.started", {
        detail: "<img src=x onerror=alert('inert')> ".repeat(7),
        workflow: {
          ...workflow,
          name: "LongWorkflowTitle".repeat(12),
          phases: [{ index: 1, title: "LongPhaseTitle".repeat(12) }],
          agents: [
            {
              index: 1,
              phaseIndex: 1,
              label: "LongAgentLabel".repeat(12),
              model: "LongModelIdentifier".repeat(5),
              status: "running",
            },
          ],
        },
      });
      const view = await render(
        <div style={{ width, maxWidth: "100%" }}>
          <ProviderTasks context={workflowContext([longWorkflow])} />
        </div>,
      );
      try {
        const card = document.querySelector<HTMLElement>("[data-workflow-task-card]")!;
        expect(card).not.toBeNull();
        expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth + 1);
        expect(card.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth + 1);
        expect(card.querySelector("img, script, a")).toBeNull();
        // The private opt-in media-preference run qualifies native reduced
        // motion without mocking matchMedia or installing a different runner.
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          expect(getComputedStyle(card).animationName).toBe("none");
          for (const row of card.querySelectorAll<HTMLElement>("[data-workflow-agent-row]")) {
            expect(getComputedStyle(row).animationName).toBe("none");
          }
        }
        const tip = page.getByRole("button", { name: "About workflow telemetry" });
        tip.element().focus();
        await userEvent.keyboard("{Enter}");
        await expect.element(tip).toHaveAttribute("aria-describedby");
        await expect
          .element(page.getByText(/Model, tokens, duration and status are reported by Claude\./))
          .toBeVisible();
        expect(
          document.getElementById(tip.element().getAttribute("aria-describedby")!)?.textContent,
        ).toContain("not a running clock");
        await userEvent.keyboard("{Escape}");
        const screenshotDirectory = import.meta.env.VITE_CLAUDE_WORKFLOW_SCREENSHOT_DIR;
        if (typeof screenshotDirectory === "string" && screenshotDirectory.length > 0) {
          // Opt-in visual evidence uses this synthetic browser harness only.
          // It never loads a user profile or sends an inference request.
          await view.rerender(
            <div style={{ width, maxWidth: "100%" }}>
              <ProviderTasks context={workflowContext()} />
            </div>,
          );
          await expect
            .element(page.getByText("1/1 reported agents done", { exact: true }))
            .toBeVisible();
          await page.screenshot({
            path: `${screenshotDirectory}/workflow-${dark ? "dark" : "light"}-${width}-${scale.replace("%", "")}.png`,
            fullPage: true,
          });
        }
      } finally {
        await view.unmount();
        document.documentElement.classList.toggle("dark", wasDark);
        document.documentElement.style.fontSize = previousFontSize;
        await page.viewport(originalViewport.width, originalViewport.height);
      }
    });
  }

  it("renders bounded non-agent native task controls with accessible pagination and authoritative removal", async () => {
    const context: ProviderTasksContext = {
      environmentId,
      threadId,
      providerInstanceId: ProviderInstanceId.make("account-a"),
      runtimeSession: { orchestrationStatus: "running", subagentRuntimeId: subagent.runtimeId },
      activities: Array.from({ length: 7 }, (_, index) => ({
        id: EventId.make(`native-${index}`),
        kind: "task.started",
        tone: "info",
        summary: `Shell task ${index}`,
        createdAt: "2026-10-05T00:00:00Z",
        turnId,
        payload: {
          taskId: `native-${index}`,
          individualTaskControl: {
            taskId: `native-${index}`,
            runtimeId: SubagentRuntimeId.make(subagent.runtimeId!),
            capability: { ...subagent.taskControl!, canBackground: false },
          },
        },
      })),
    };
    controlTask.mockResolvedValue({ status: "accepted" });
    const view = await render(<ProviderTasks context={context} />);
    await expect.element(page.getByRole("region", { name: "Active provider tasks" })).toBeVisible();
    await expect.element(page.getByText("Shell task 5", { exact: true })).not.toBeInTheDocument();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect.element(page.getByText("Shell task 5", { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Run in background" }))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: "Stop task", exact: true }).first().click();
    expect(controlTask.mock.calls[0]?.[0]).toMatchObject({ taskId: "native-5", action: "stop" });
    await view.rerender(<ProviderTasks context={{ ...context, activities: [] }} />);
    await expect
      .element(page.getByRole("button", { name: "Stop task", exact: true }))
      .not.toBeInTheDocument();
  });
  it("offers accessible explicit priority choices and explains Later is not a schedule", async () => {
    await render(<PriorityHarness />);
    await expect
      .element(page.getByText("Message delivery", { exact: true }))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: "More composer controls" }).click();
    await expect
      .element(page.getByRole("menuitemradio", { name: "Automatic", exact: true }))
      .toHaveAttribute("aria-checked", "true");
    const now = page.getByRole("menuitemradio", { name: "Now", exact: true });
    await now.hover();
    await expect
      .element(page.getByRole("tooltip"))
      .toHaveTextContent("Join the active turn; supported work may move to the background.");
    await now.click();
    await expect.element(now).toHaveAttribute("aria-checked", "true");
    const later = page.getByRole("menuitemradio", { name: "Later", exact: true });
    await later.hover();
    await expect
      .element(page.getByRole("tooltip"))
      .toHaveTextContent("Let Claude defer this behind more urgent messages—not a scheduled time.");
    await later.click();
    await expect.element(later).toHaveAttribute("aria-checked", "true");
  });
  it("binds stop to the displayed account/runtime/task incarnation and waits for native completion", async () => {
    controlTask.mockResolvedValue({ status: "accepted" });
    const view = await render(
      <SubagentTaskControls {...{ environmentId, threadId, turnId, subagent }} />,
    );
    await page.getByRole("button", { name: "Stop task", exact: true }).click();
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Stop requested. Waiting for the provider’s status update.");
    expect(controlTask).toHaveBeenCalledExactlyOnceWith({
      threadId,
      turnId,
      providerInstanceId: "account-a",
      runtimeId: subagent.runtimeId,
      taskId: "native-task",
      taskGeneration: subagent.taskControl!.taskGeneration,
      action: "stop",
    });
    await expect
      .element(page.getByRole("button", { name: "Stop task", exact: true }))
      .toBeDisabled();
    await view.rerender(
      <SubagentTaskControls
        {...{ environmentId, threadId, turnId }}
        subagent={{ ...subagent, status: "stopped" }}
      />,
    );
    await expect
      .element(page.getByRole("button", { name: "Stop task", exact: true }))
      .not.toBeInTheDocument();
  });
  it("keeps uncertain background outcomes distinct and never sends an implicit background-all request", async () => {
    controlTask.mockResolvedValue({ status: "unknown" });
    await render(<SubagentTaskControls {...{ environmentId, threadId, turnId, subagent }} />);
    await page.getByRole("button", { name: "Run in background" }).click();
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent(
        "Delivery is uncertain. Waiting for a provider update; this action will not be repeated automatically.",
      );
    expect(controlTask.mock.calls[0]?.[0]).toMatchObject({
      action: "background",
      taskId: "native-task",
    });
    await expect.element(page.getByRole("button", { name: "Run in background" })).toBeDisabled();
  });
  it("does not expose controls for missing capability or unverified liveness", async () => {
    await render(
      <SubagentTaskControls
        {...{ environmentId, threadId, turnId }}
        subagent={{ ...subagent, status: "unknown" }}
      />,
    );
    await expect
      .element(page.getByRole("button", { name: "Stop task", exact: true }))
      .not.toBeInTheDocument();
    expect(controlTask).not.toHaveBeenCalled();
  });
});
