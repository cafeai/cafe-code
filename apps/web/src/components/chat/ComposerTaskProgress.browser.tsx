import "../../index.css";

import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerTaskProgress, type ComposerTaskProgressPlan } from "./ComposerTaskProgress";

async function mountProgress(
  plan: ComposerTaskProgressPlan | null,
  options?: { readonly composerBottom?: boolean },
) {
  const host = document.createElement("div");
  if (options?.composerBottom) {
    host.className = "fixed bottom-2 left-2";
  }
  document.body.append(host);
  const screen = await render(<ComposerTaskProgress plan={plan} />, { container: host });

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

describe("ComposerTaskProgress", () => {
  afterEach(() => {
    document.body.innerHTML = "";
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
      await expect.element(trigger).toHaveTextContent("Step 2 / 3");

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
});
