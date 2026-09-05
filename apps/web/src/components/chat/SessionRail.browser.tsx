import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { EventId, TurnId } from "@cafecode/contracts";

import { deriveLatestContextWindowSnapshot } from "../../lib/contextWindow";
import type { WorkLogEntry } from "../../session-logic";
import { SessionRail } from "./SessionRail";
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
    document.body.innerHTML = "";
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
        "Waiting for usage from this thread.",
      );
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
