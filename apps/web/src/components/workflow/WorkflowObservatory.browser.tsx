import "../../index.css";

import type { OrchestrationThreadActivity } from "@cafecode/contracts";
import { EventId, ProviderDriverKind, ThreadId, TurnId } from "@cafecode/contracts";
import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { WorkflowLatestTurn } from "../../workflowProjection";
import { CompactComposerControlsMenu } from "../chat/CompactComposerControlsMenu";
import { WorkflowObservatoryDialog } from "./WorkflowObservatoryDialog";

const TURN = TurnId.make("turn-1");

let sequence = 0;

function activity(
  kind: string,
  payload: unknown,
  overrides: Partial<OrchestrationThreadActivity> = {},
): OrchestrationThreadActivity {
  sequence += 1;
  return {
    id: EventId.make(`event-${sequence}`),
    tone: "tool",
    kind,
    summary: `${kind} for ${String((payload as { taskId?: string }).taskId ?? "thread")}`,
    payload,
    turnId: TURN,
    sequence,
    createdAt: new Date(Date.UTC(2026, 8, 11, 12, 0, sequence)).toISOString(),
    ...overrides,
  } as OrchestrationThreadActivity;
}

const RUNNING_TURN: WorkflowLatestTurn = {
  turnId: TURN,
  state: "running",
  requestedAt: "2026-09-11T12:00:00.000Z",
  startedAt: "2026-09-11T12:00:01.000Z",
  completedAt: null,
};

/** Fixture events. These are written here, not captured from a provider. */
function fixtureActivities(prefix: string): OrchestrationThreadActivity[] {
  return [
    activity("task.started", {
      taskId: `${prefix}-audit`,
      taskType: "subagent",
      subagent: {
        threadId: `${prefix}-audit`,
        label: `${prefix} audit`,
        objective: "Check the release notes",
        status: "active",
      },
    }),
    activity("task.progress", {
      taskId: `${prefix}-audit`,
      description: "Reading the changelog",
      subagent: { threadId: `${prefix}-audit`, status: "active" },
    }),
    activity("task.started", {
      taskId: `${prefix}-docs`,
      taskType: "subagent",
      subagent: {
        threadId: `${prefix}-docs`,
        label: `${prefix} docs`,
        objective: "Update the guide",
        status: "active",
      },
    }),
    activity("task.completed", {
      taskId: `${prefix}-docs`,
      status: "completed",
      subagent: { threadId: `${prefix}-docs`, status: "completed" },
    }),
  ];
}

async function mountDialog(
  overrides: Partial<Parameters<typeof WorkflowObservatoryDialog>[0]> = {},
) {
  const host = document.createElement("div");
  document.body.append(host);
  const props = {
    activePlan: null,
    activities: fixtureActivities("alpha"),
    environmentId: "environment-local",
    latestTurn: RUNNING_TURN,
    modelLabel: "gpt-5.2",
    onOpenChange: vi.fn(),
    open: true,
    providerLabel: "codex",
    threadId: ThreadId.make("thread-1") as string,
    threadTitle: "Ship the release",
    timestampFormat: "24-hour" as const,
    ...overrides,
  };
  const screen = await render(<WorkflowObservatoryDialog {...props} />, { container: host });

  return {
    props,
    screen,
    rerender: (next: Partial<typeof props>) =>
      screen.rerender(<WorkflowObservatoryDialog {...props} {...next} />),
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

const dialogRoot = () => document.querySelector('[data-testid="workflow-observatory-dialog"]');

describe("WorkflowObservatoryDialog", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens without a proposed plan and states that no plan is reported", async () => {
    const mounted = await mountDialog({ activePlan: null });

    await vi.waitFor(() => expect(dialogRoot()).not.toBeNull());
    expect(dialogRoot()?.textContent).toContain("No plan reported for this thread.");
    expect(dialogRoot()?.textContent).toContain("Ship the release");

    await mounted.cleanup();
  });

  it("shows the reported agents, the fidelity, and the source summary", async () => {
    const mounted = await mountDialog();

    await vi.waitFor(() => expect(dialogRoot()).not.toBeNull());
    expect(document.querySelector('[data-testid="workflow-fidelity"]')?.textContent).toBe(
      "Live progress",
    );
    const summary = document.querySelector('[data-testid="workflow-source-summary"]')?.textContent;
    expect(summary).toContain("Provider: codex");
    expect(summary).toContain("Model: gpt-5.2");
    expect(summary).toContain("Agents reported: 2");
    expect(dialogRoot()?.textContent).toContain("alpha audit");
    expect(dialogRoot()?.textContent).toContain("alpha docs");

    await mounted.cleanup();
  });

  it("expands and collapses one node detail", async () => {
    const mounted = await mountDialog();

    await vi.waitFor(() => expect(dialogRoot()).not.toBeNull());
    const completed = document.querySelector<HTMLButtonElement>(
      '[data-testid^="workflow-node-agent:"] button[aria-expanded="false"]',
    );
    expect(completed).not.toBeNull();
    await userEvent.click(completed!);
    await vi.waitFor(() => expect(completed!.getAttribute("aria-expanded")).toBe("true"));
    expect(completed!.closest("li")?.textContent).toContain("Observed span:");

    await userEvent.click(completed!);
    await vi.waitFor(() => expect(completed!.getAttribute("aria-expanded")).toBe("false"));

    await mounted.cleanup();
  });

  it("switches between the list view and the graph view", async () => {
    const mounted = await mountDialog();

    await vi.waitFor(() => expect(dialogRoot()).not.toBeNull());
    expect(document.querySelector('[data-testid="workflow-graph"]')).toBeNull();

    const graphButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Graph",
    );
    await userEvent.click(graphButton!);
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="workflow-graph"]')).not.toBeNull(),
    );

    const nodeButtons = document.querySelectorAll('[data-testid^="workflow-graph-node-"]');
    expect(nodeButtons).toHaveLength(3);
    await userEvent.click(nodeButtons[2] as HTMLElement);
    await vi.waitFor(() =>
      expect(
        document.querySelector('[data-testid="workflow-graph-selection"]')?.textContent,
      ).toContain("Recorded by: Ship the release"),
    );

    await mounted.cleanup();
  });

  it("replaces the projection and the view state on a thread switch", async () => {
    const mounted = await mountDialog();

    await vi.waitFor(() => expect(dialogRoot()).not.toBeNull());
    const graphButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Graph",
    );
    await userEvent.click(graphButton!);
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="workflow-graph"]')).not.toBeNull(),
    );

    await mounted.rerender({
      activities: fixtureActivities("beta"),
      threadId: ThreadId.make("thread-2") as string,
      threadTitle: "Second thread",
    });

    await vi.waitFor(() => expect(dialogRoot()?.textContent).toContain("Second thread"));
    expect(dialogRoot()?.textContent).not.toContain("alpha audit");
    expect(dialogRoot()?.textContent).toContain("beta audit");
    // The graph selection belongs to the previous thread, so the switch returns
    // to the list view.
    expect(document.querySelector('[data-testid="workflow-graph"]')).toBeNull();

    await mounted.cleanup();
  });

  it("resets view state across delimiter-colliding environment and thread identifiers", async () => {
    const mounted = await mountDialog({ environmentId: "environment:remote", threadId: "thread" });
    try {
      await vi.waitFor(() => expect(dialogRoot()).not.toBeNull());
      const graphButton = [...document.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Graph",
      );
      await userEvent.click(graphButton!);
      await vi.waitFor(() =>
        expect(document.querySelector('[data-testid="workflow-graph"]')).not.toBeNull(),
      );
      await mounted.rerender({ environmentId: "environment", threadId: "remote:thread" });
      expect(document.querySelector('[data-testid="workflow-graph"]')).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps an environment switch from showing the previous environment data", async () => {
    const mounted = await mountDialog();

    await vi.waitFor(() => expect(dialogRoot()).not.toBeNull());
    await mounted.rerender({
      activities: fixtureActivities("gamma"),
      environmentId: "environment-remote",
      threadTitle: "Remote thread",
    });

    await vi.waitFor(() => expect(dialogRoot()?.textContent).toContain("Remote thread"));
    expect(dialogRoot()?.textContent).not.toContain("alpha audit");
    expect(dialogRoot()?.textContent).toContain("gamma audit");

    await mounted.cleanup();
  });

  it("states that the provider reported no agent lifecycle", async () => {
    const mounted = await mountDialog({
      activities: [activity("message.delta", { text: "hello" })],
    });

    await vi.waitFor(() => expect(dialogRoot()).not.toBeNull());
    expect(document.querySelector('[data-testid="workflow-fidelity"]')?.textContent).toBe(
      "Not reported",
    );
    expect(document.querySelector('[data-testid="workflow-no-agents"]')?.textContent).toContain(
      "reported no agent lifecycle",
    );

    await mounted.cleanup();
  });

  it("always states the read-only limits", async () => {
    const mounted = await mountDialog();

    await vi.waitFor(() => expect(dialogRoot()).not.toBeNull());
    const limits = document.querySelector('[data-testid="workflow-limits"]')?.textContent ?? "";
    expect(limits).toContain("does not poll or prompt the provider");
    expect(limits).toContain("Providers do not report which agent started another agent");
    expect(limits).toContain("Providers report no task duration");

    await mounted.cleanup();
  });

  it("shows nothing while the panel is closed", async () => {
    const mounted = await mountDialog({ open: false });

    expect(dialogRoot()).toBeNull();

    await mounted.cleanup();
  });
});

describe("composer workflow control", () => {
  it("offers the workflow control when no plan sidebar is available", async () => {
    const onOpenWorkflowObservatory = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <CompactComposerControlsMenu
        interactionMode="default"
        onNativePermissionModeChange={vi.fn()}
        onOpenWorkflowObservatory={onOpenWorkflowObservatory}
        onRuntimeModeChange={vi.fn()}
        onToggleInteractionMode={vi.fn()}
        onTogglePlanSidebar={vi.fn()}
        planSidebarLabel="Plan"
        planSidebarOpen={false}
        provider={ProviderDriverKind.make("codex")}
        runtimeMode="approval-required"
        showInteractionModeToggle={false}
        showPlanSidebar={false}
      />,
      { container: host },
    );

    await userEvent.click(host.querySelector("button")!);
    const item = await vi.waitUntil(() =>
      document.querySelector<HTMLElement>('[data-testid="compact-open-workflow-observatory"]'),
    );
    await userEvent.click(item);
    expect(onOpenWorkflowObservatory).toHaveBeenCalledTimes(1);

    await screen.unmount();
    host.remove();
  });
});
