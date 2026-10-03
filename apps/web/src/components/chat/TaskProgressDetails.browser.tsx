import "../../index.css";

import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import type { WorkLogEntry } from "../../session-logic";
import { TaskProgressDetails } from "./TaskProgressDetails";

function roster(): WorkLogEntry[] {
  // Deliberately old timestamps prove visibility depends only on the canonical
  // derived lifecycle, never on age, elapsed time, label or turn ordering.
  return (["active", "waiting", "completed", "failed", "stopped"] as const).map((status) => ({
    id: `worker-${status}`,
    label: `Worker ${status}`,
    tone: "thinking",
    createdAt: "2020-01-01T00:00:00.000Z",
    subagent: {
      id: `worker-${status}`,
      label: `Worker ${status}`,
      status,
      startedAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z",
    },
  }));
}

describe("Tasks current-worker details", () => {
  let mounted: Awaited<ReturnType<typeof render>> | undefined;
  afterEach(async () => {
    await mounted?.unmount();
    mounted = undefined;
  });

  it("admits only active and waiting workers even when a caller supplies complete history", async () => {
    const history = roster();
    mounted = await render(<TaskProgressDetails plan={null} subagents={history} />);
    await expect
      .element(page.getByRole("button", { name: /^Worker active, Working\./ }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: /^Worker waiting, Waiting\./ }))
      .toBeVisible();
    expect(document.querySelectorAll('[data-composer-subagent-list="true"] button')).toHaveLength(
      2,
    );
    for (const status of ["completed", "failed", "stopped"])
      expect(document.body.textContent).not.toContain(`Worker ${status}`);
    // Filtering is view-only: the same complete input remains usable by Atrium.
    expect(history.map((entry) => entry.subagent?.status)).toEqual([
      "active",
      "waiting",
      "completed",
      "failed",
      "stopped",
    ]);
  });

  it("removes terminal workers on live update while retaining the complete task plan", async () => {
    const history = roster();
    const plan = {
      steps: [
        { step: "Completed plan step stays visible", status: "completed" as const },
        { step: "Current plan step stays visible", status: "inProgress" as const },
      ],
    };
    mounted = await render(<TaskProgressDetails plan={plan} subagents={history} />);
    await mounted.rerender(
      <TaskProgressDetails
        plan={plan}
        subagents={history.map((entry) =>
          entry.subagent
            ? { ...entry, subagent: { ...entry.subagent, status: "completed" as const } }
            : entry,
        )}
      />,
    );
    expect(document.querySelector('[data-composer-subagent-list="true"]')).toBeNull();
    await expect
      .element(page.getByText("Completed plan step stays visible", { exact: false }))
      .toBeVisible();
    await expect
      .element(page.getByText("Current plan step stays visible", { exact: false }))
      .toBeVisible();
    expect(document.querySelectorAll('[data-composer-task-progress-step="true"]')).toHaveLength(2);
  });
});
