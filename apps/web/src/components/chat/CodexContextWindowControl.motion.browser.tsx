import "../../index.css";
import { page, userEvent } from "vitest/browser";
import { afterEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { CodexContextWindowControl } from "./CodexContextWindowControl";
import { deriveCodexContextWindowPresentation } from "../../codexContextWindow";
import { ContextWindowDetails } from "./ContextWindowDetails";
import type { ContextWindowSnapshot } from "../../lib/contextWindow";

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

const usage: ContextWindowSnapshot = {
  usedTokens: 95_000,
  maxTokens: 475_000,
  remainingTokens: 380_000,
  usedPercentage: 20,
  remainingPercentage: 80,
  updatedAt: "2026-10-13T00:00:00.000Z",
  totalProcessedTokens: 2_600_000,
  inputTokens: null,
  cachedInputTokens: null,
  cacheWriteInputTokens: null,
  totalCacheWriteInputTokens: null,
  outputTokens: null,
  reasoningOutputTokens: null,
  lastUsedTokens: null,
  lastInputTokens: null,
  lastCachedInputTokens: null,
  lastCacheWriteInputTokens: null,
  lastOutputTokens: null,
  lastReasoningOutputTokens: null,
  toolUses: null,
  durationMs: null,
  compactsAutomatically: true,
  autoCompactTokenLimit: null,
};

it.each([false, true].flatMap((dark) => [80, 130].map((scale) => ({ dark, scale }))))(
  "keeps narrow context facts as dense as the primary quota window under real reduced motion (dark=$dark scale=$scale)",
  async ({ dark, scale }) => {
    expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
    await page.viewport(430, 680);
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.style.fontSize = `${scale}%`;
    mounted = await render(
      <div style={{ width: 280 }}>
        <ContextWindowDetails
          usage={usage}
          layout="panel"
          rateLimits={{
            checkedAt: "2026-10-13T00:00:00.000Z",
            rateLimits: {
              primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: 1_780_000_000 },
            },
          }}
          codexContextWindow={deriveCodexContextWindowPresentation({
            requested: 800_000,
            configured: 500_000,
          })}
        />
      </div>,
    );
    await expect
      .element(page.getByText("Context override: 500K → 800K when idle", { exact: true }))
      .toBeVisible();
    await expect.element(page.getByText("(~720K compaction)", { exact: true })).toBeVisible();
    await expect.element(page.getByText("475k context used", { exact: true })).toBeVisible();
    const facts = document.querySelector<HTMLElement>("[data-context-window-facts]")!;
    const rows = Array.from(facts.children) as HTMLElement[];
    expect(rows).toHaveLength(3);
    const primary = document.querySelector<HTMLElement>('[data-account-quota-window="primary"]')!;
    const primaryRows = Array.from(primary.children) as HTMLElement[];
    const primaryGap =
      primaryRows.at(-1)!.getBoundingClientRect().top -
      primaryRows.at(-2)!.getBoundingClientRect().bottom;
    const rootRem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    expect(Math.abs(primaryGap - rootRem * 0.25)).toBeLessThanOrEqual(0.75);
    for (const [index, row] of rows.entries()) {
      expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
      expect(row.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
      const style = getComputedStyle(row);
      expect(
        Math.abs(Number.parseFloat(style.lineHeight) - Number.parseFloat(style.fontSize) * 1.25),
      ).toBeLessThanOrEqual(0.1);
      if (index > 0) {
        const gap =
          row.getBoundingClientRect().top - rows[index - 1]!.getBoundingClientRect().bottom;
        expect(Math.abs(gap - primaryGap)).toBeLessThanOrEqual(0.75);
      }
    }
    const summary = document.querySelector<HTMLElement>("[data-codex-context-window-details]")!;
    expect(summary.scrollWidth).toBeLessThanOrEqual(summary.clientWidth + 1);
  },
);

// This file runs only in a provider-owned reduced-motion context. No CDP or
// matchMedia mutation leaks device policy onto an ordinary desktop worker.
it("retains accessible context-dialog input and stationary reduced-motion geometry", async () => {
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
      })}
      onChange={async () => {}}
    />,
  );
  const dialog = page.getByRole("dialog").element();
  const estimate = page.getByText("(~450K compaction)", { exact: true });
  await expect.element(estimate).toBeVisible();
  const summary = estimate.element().closest<HTMLElement>("[data-codex-context-window-details]")!;
  expect(summary.scrollWidth).toBeLessThanOrEqual(summary.clientWidth + 1);
  const style = getComputedStyle(dialog);
  expect(style.transform).toBe("none");
  expect(style.translate === "none" || style.translate === "0px").toBe(true);
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
