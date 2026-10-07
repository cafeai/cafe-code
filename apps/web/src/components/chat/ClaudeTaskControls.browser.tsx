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
} from "@cafecode/contracts";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
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
