import { afterEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import { deriveCodexContextWindowPresentation } from "../../codexContextWindow";
import "../../index.css";
import { CodexContextWindowControl } from "./CodexContextWindowControl";

let mounted: Awaited<ReturnType<typeof render>> | undefined;
const originalFontSize = document.documentElement.style.fontSize;
const originalDark = document.documentElement.classList.contains("dark");
const originalViewport = { width: window.innerWidth, height: window.innerHeight };
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  document.documentElement.style.fontSize = originalFontSize;
  document.documentElement.classList.toggle("dark", originalDark);
  await page.viewport(originalViewport.width, originalViewport.height);
});

// This file runs only in a provider-owned reduced-motion context. No CDP or
// matchMedia mutation leaks device policy onto an ordinary desktop worker.
it("retains accessible context-dialog input under reduced motion", async () => {
  expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
  mounted = await render(
    <CodexContextWindowControl
      open
      onOpenChange={() => {}}
      supported
      override={500_000}
      presentation={deriveCodexContextWindowPresentation({
        requested: 500_000,
        configured: 500_000,
        configuredAutoCompactTokenLimit: 500_000,
        canApplyWhenIdle: true,
      })}
      onChange={async () => {}}
    />,
  );
  await expect.element(page.getByRole("dialog")).toBeVisible();
  const estimate = page.getByText("(~450K compaction)", { exact: true });
  await expect.element(estimate).toBeVisible();
  const summary = estimate.element().closest<HTMLElement>("[data-codex-context-window-details]")!;
  expect(summary.scrollWidth).toBeLessThanOrEqual(summary.clientWidth + 1);
  const input = page.getByRole("spinbutton", { name: "Context window (tokens)", exact: true });
  await input.fill("600000");
  input.element().focus();
  await userEvent.keyboard("{Tab}");
  expect(document.activeElement).toBe(
    page.getByRole("button", { name: "About context-window overrides", exact: true }).element(),
  );
  await expect.element(page.getByText("Source: Chat override.", { exact: true })).toBeVisible();
  await expect.element(input).toHaveValue(600_000);
  // Unsaved editor input must not become an applied/requested threshold claim.
  await expect.element(estimate).toHaveTextContent("(~450K compaction)");
});
