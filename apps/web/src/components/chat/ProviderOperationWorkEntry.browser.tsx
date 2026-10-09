import "../../index.css";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { ClaudeCommandWorkEntry, ClaudeSummaryWorkEntry } from "./ProviderOperationWorkEntry";
import type { ClaudeCommandInspection } from "./providerOperationVisibility";

async function waitForExpandedPanelGeometry(row: HTMLElement) {
  await vi.waitFor(() => {
    const panel = row.querySelector<HTMLElement>('[data-slot="collapsible-panel"]');
    expect(panel).not.toBeNull();
    const bottom = Math.max(
      ...Array.from(panel!.children, (child) => child.getBoundingClientRect().bottom),
    );
    expect(panel!.getBoundingClientRect().height).toBeGreaterThan(0);
    expect(panel!.getBoundingClientRect().bottom).toBeGreaterThanOrEqual(bottom - 1);
  });
}

describe("inspectable received Claude operation text", () => {
  const originalViewport = { width: window.innerWidth, height: window.innerHeight };
  let mounted: Awaited<ReturnType<typeof render>> | undefined;
  afterEach(async () => {
    await mounted?.unmount();
    mounted = undefined;
    document.documentElement.classList.remove("dark");
    document.documentElement.style.removeProperty("font-size");
    await page.viewport(originalViewport.width, originalViewport.height);
  });

  for (const [width, dark, scale] of [
    [430, true, "130%"],
    [960, false, "80%"],
  ] as const) {
    it(`keeps command/output collapsed, keyboard accessible, and inert at ${width}px`, async () => {
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.style.fontSize = scale;
      await page.viewport(width + 24, 900);
      const inspection: ClaudeCommandInspection = {
        description: "Run focused tests",
        descriptionTruncated: true,
        command: `yarn test --filter=${"long-command".repeat(40)}`,
        commandTruncated: false,
        output: `<img src=x onerror=alert('not executed')>\n${"received output ".repeat(100)}`,
        outputTruncated: true,
        status: "failed",
        startedAt: "2026-10-09T00:00:00.000Z",
        completedAt: "2026-10-09T00:00:02.000Z",
      };
      mounted = await render(
        <div style={{ width, maxWidth: "100%" }}>
          <ClaudeCommandWorkEntry inspection={inspection} timestampFormat="24-hour" />
        </div>,
      );
      const trigger = page.getByRole("button", { name: "Inspect command: Run focused tests" });
      await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
      expect(document.querySelector("[data-command-inspection-output]")).toBeNull();
      trigger.element().focus();
      await userEvent.keyboard("{Enter}");
      await expect.element(trigger).toHaveAttribute("aria-expanded", "true");
      await expect
        .element(page.getByText("Output truncated to the retained preview.", { exact: true }))
        .toBeVisible();
      await expect
        .element(page.getByText("Description truncated to the retained preview.", { exact: true }))
        .toBeVisible();
      await expect.element(page.getByText("Observed duration 2s", { exact: true })).toBeVisible();
      const row = document.querySelector<HTMLElement>("[data-claude-command-inspection]")!;
      await waitForExpandedPanelGeometry(row);
      expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
      expect(row.querySelector("img, script")).toBeNull();
      expect(row.querySelector("[data-command-inspection-output]")?.textContent).toBe(
        inspection.output,
      );
      // Local opt-in visual evidence uses the same synthetic harness; normal
      // CI runs do not write screenshots or access an application/account.
      const screenshotDirectory = import.meta.env.VITE_CLAUDE_OPERATION_SCREENSHOT_DIR;
      if (typeof screenshotDirectory === "string" && screenshotDirectory.length > 0) {
        await mounted.rerender(
          <div style={{ width, maxWidth: "100%" }}>
            <ClaudeCommandWorkEntry
              inspection={{
                ...inspection,
                descriptionTruncated: false,
                command: "yarn workspace @cafecode/web test src/session-logic.test.ts",
                output:
                  "Running focused checks\nFixture assertion failed\nSee the test output for details.",
                outputTruncated: false,
              }}
              timestampFormat="24-hour"
            />
          </div>,
        );
        await waitForExpandedPanelGeometry(row);
        await page.screenshot({
          path: `${screenshotDirectory}/command-${dark ? "dark" : "light"}-${width}-${scale.replace("%", "")}.png`,
          fullPage: true,
        });
      }
      // A received snapshot updates the same open disclosure without provider
      // actions, a second scroll owner, or control/approval surfaces.
      await mounted.rerender(
        <div style={{ width, maxWidth: "100%" }}>
          <ClaudeCommandWorkEntry
            inspection={{
              ...inspection,
              output: "Final received output",
              outputTruncated: false,
              status: "completed",
            }}
            timestampFormat="24-hour"
          />
        </div>,
      );
      await expect.element(trigger).toHaveAttribute("aria-expanded", "true");
      await expect.element(page.getByText("Completed", { exact: true })).toBeVisible();
      await expect.element(page.getByText("Final received output", { exact: true })).toBeVisible();
      trigger.element().focus();
      await userEvent.keyboard(" ");
      await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
    });
  }

  it("distinguishes running, omitted, empty and unknown output/timing honestly", async () => {
    const base: ClaudeCommandInspection = {
      command: "yarn test",
      commandTruncated: false,
      outputTruncated: false,
      status: "inProgress",
    };
    mounted = await render(<ClaudeCommandWorkEntry inspection={base} timestampFormat="24-hour" />);
    await page.getByRole("button", { name: "Inspect command: yarn test" }).click();
    await expect.element(page.getByText("No output received yet.", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Timing not recorded.", { exact: true })).toBeVisible();
    await mounted.rerender(
      <ClaudeCommandWorkEntry
        inspection={{ ...base, status: "failed" }}
        timestampFormat="24-hour"
      />,
    );
    await expect.element(page.getByText("Output not recorded.", { exact: true })).toBeVisible();
    await mounted.rerender(
      <ClaudeCommandWorkEntry
        inspection={{ ...base, output: "", status: "completed" }}
        timestampFormat="24-hour"
      />,
    );
    await expect
      .element(page.getByText("No displayable output retained.", { exact: true }))
      .toBeVisible();
    await mounted.rerender(
      <ClaudeCommandWorkEntry
        inspection={{ commandTruncated: false, outputTruncated: false }}
        timestampFormat="24-hour"
      />,
    );
    await expect.element(page.getByText("Status not recorded", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Command not recorded.", { exact: true })).toBeVisible();
  });

  it("shows received public summary text live and preserves a read-only disclosure on updates", async () => {
    mounted = await render(
      <div style={{ width: 430 }}>
        <ClaudeSummaryWorkEntry
          summary={{
            text: "Checking the repository before editing.",
            truncated: false,
            status: "inProgress",
          }}
        />
      </div>,
    );
    await expect.element(page.getByText("Claude summary", { exact: true })).toBeVisible();
    await expect
      .element(page.getByText("Checking the repository before editing.", { exact: true }))
      .toBeVisible();
    await expect.element(page.getByText("Updating…", { exact: true })).toBeVisible();
    const trigger = page.getByRole("button", { name: "Inspect summary", exact: true });
    trigger.element().focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(trigger).toHaveAttribute("aria-expanded", "true");
    await mounted.rerender(
      <div style={{ width: 430 }}>
        <ClaudeSummaryWorkEntry
          summary={{
            text: "Checks complete.\nProceeding with the fix.",
            truncated: true,
            status: "completed",
          }}
        />
      </div>,
    );
    await expect
      .element(page.getByText("Summary truncated to the retained preview.", { exact: true }))
      .toBeVisible();
    expect(document.querySelector("[data-summary-preview]")).toBeNull();
    expect(document.querySelector("[data-summary-full-text]")?.textContent).toBe(
      "Checks complete.\nProceeding with the fix.",
    );
    await expect.element(trigger).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelector("textarea, input, [contenteditable=true]")).toBeNull();
    const screenshotDirectory = import.meta.env.VITE_CLAUDE_OPERATION_SCREENSHOT_DIR;
    if (typeof screenshotDirectory === "string" && screenshotDirectory.length > 0) {
      document.documentElement.classList.add("dark");
      document.documentElement.style.fontSize = "130%";
      await page.viewport(454, 900);
      await waitForExpandedPanelGeometry(
        document.querySelector<HTMLElement>("[data-claude-public-summary]")!,
      );
      await page.screenshot({
        path: `${screenshotDirectory}/summary-dark-430-130.png`,
        fullPage: true,
      });
    }
  });
});
