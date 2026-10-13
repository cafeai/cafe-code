import "../../index.css";

import type { ServerProviderAccountRateLimits } from "@cafecode/contracts";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { ContextWindowDetails } from "./ContextWindowDetails";
import { SessionRail } from "./SessionRail";
import { deriveCodexContextWindowPresentation } from "../../codexContextWindow";
import type { ContextWindowSnapshot } from "../../lib/contextWindow";

const rateLimits: ServerProviderAccountRateLimits = {
  checkedAt: "2026-09-24T00:00:00.000Z",
  rateLimits: {
    limitId: "codex",
    primary: { usedPercent: 98, windowDurationMins: 300, resetsAt: 1_780_000_000 },
  },
  rateLimitResetCredits: { availableCount: 0 },
};

async function settledRail() {
  const rail = document.querySelector<HTMLElement>("[data-session-rail]")!;
  // Retain the actual final layout rather than a partially faded entrance.
  // This observes the existing finite animation; it changes no media policy,
  // deadline or style and does not wait for unrelated application animations.
  await Promise.all(rail.getAnimations().map((animation) => animation.finished));
  expect(getComputedStyle(rail).opacity).toBe("1");
  return rail;
}

function assertCompactPolicyRows() {
  const subagent = document.querySelector<HTMLElement>("[data-subagent-concurrency-details]")!;
  const context = document.querySelector<HTMLElement>("[data-codex-context-window-details]")!;
  expect(subagent).not.toBeNull();
  expect(context).not.toBeNull();
  const section = subagent.parentElement!;
  expect(context.parentElement).toBe(section);
  expect(Array.from(section.children)).toEqual([subagent, context]);
  const subagentRect = subagent.getBoundingClientRect();
  const contextRect = context.getBoundingClientRect();
  const sectionRect = section.getBoundingClientRect();
  const rootRem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  // Assert the rendered density, not merely the presence of gap-1. The
  // old separate sections added their outer spacing to context padding.
  const gap = contextRect.top - subagentRect.bottom;
  expect(gap).toBeGreaterThanOrEqual(0);
  expect(Math.abs(gap - rootRem * 0.25)).toBeLessThanOrEqual(0.75);
  expect(Number.parseFloat(getComputedStyle(section).borderTopWidth)).toBeGreaterThan(0);
  for (const row of [subagent, context]) {
    const rect = row.getBoundingClientRect();
    expect(rect.height).toBeGreaterThan(0);
    expect(rect.left).toBeGreaterThanOrEqual(sectionRect.left - 1);
    expect(rect.right).toBeLessThanOrEqual(sectionRect.right + 1);
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
  }
  expect(sectionRect.right).toBeLessThanOrEqual(window.innerWidth);
}

function assertCompactContextFacts() {
  const facts = document.querySelector<HTMLElement>("[data-context-window-facts]")!;
  const rows = Array.from(facts.children) as HTMLElement[];
  expect(rows).toHaveLength(3);
  const primary = document.querySelector<HTMLElement>('[data-account-quota-window="primary"]')!;
  expect(primary).not.toBeNull();
  const primaryRows = Array.from(primary.children) as HTMLElement[];
  const primaryLast = primaryRows.at(-1)!;
  const primaryPrevious = primaryRows.at(-2)!;
  const primaryGap =
    primaryLast.getBoundingClientRect().top - primaryPrevious.getBoundingClientRect().bottom;
  const rootRem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  expect(Math.abs(primaryGap - rootRem * 0.25)).toBeLessThanOrEqual(0.75);
  for (const [index, row] of rows.entries()) {
    const style = getComputedStyle(row);
    expect(
      Math.abs(Number.parseFloat(style.lineHeight) - Number.parseFloat(style.fontSize) * 1.25),
    ).toBeLessThanOrEqual(0.1);
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
    if (index > 0) {
      const gap = row.getBoundingClientRect().top - rows[index - 1]!.getBoundingClientRect().bottom;
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(Math.abs(gap - primaryGap)).toBeLessThanOrEqual(0.75);
    }
  }
  // These outer boundaries stay distinct from the compact fact grouping.
  const quota = primary.closest<HTMLElement>("[data-account-quota]")!.parentElement!;
  expect(quota.parentElement).toBe(facts.parentElement);
  expect(Number.parseFloat(getComputedStyle(quota).borderTopWidth)).toBeGreaterThan(0);
  expect(Number.parseFloat(getComputedStyle(quota).paddingTop)).toBe(rootRem * 0.5);
}

function assertSinglePolicyRow(row: HTMLElement) {
  const section = row.parentElement!;
  expect(Array.from(section.children)).toEqual([row]);
  const style = getComputedStyle(section);
  const border = Number.parseFloat(style.borderTopWidth);
  expect(border).toBeGreaterThan(0);
  // A retained one-row section keeps its original separator but must
  // not reserve the removed row's height, gap, margin or padding.
  expect(
    Math.abs(
      section.getBoundingClientRect().height -
        row.getBoundingClientRect().height -
        border -
        Number.parseFloat(style.paddingTop),
    ),
  ).toBeLessThanOrEqual(1);
  return section;
}

describe("ContextWindowDetails reset availability", () => {
  const originalViewport = { width: window.innerWidth, height: window.innerHeight };
  const originalFontSize = document.documentElement.style.fontSize;
  const originalDark = document.documentElement.classList.contains("dark");
  let mounted: Awaited<ReturnType<typeof render>> | undefined;
  afterEach(async () => {
    await mounted?.unmount();
    mounted = undefined;
    document.documentElement.style.fontSize = originalFontSize;
    document.documentElement.classList.toggle("dark", originalDark);
    await page.viewport(originalViewport.width, originalViewport.height);
  });

  it.each(
    (["popover", "panel", "rail"] as const).flatMap((layout) =>
      ["light", "dark"].flatMap((theme) => [80, 130].map((scale) => ({ layout, theme, scale }))),
    ),
  )(
    "keeps adjacent policy rows compact and native capacity distinct in narrow $layout $theme $scale% layouts",
    async ({ layout, theme, scale }) => {
      await page.viewport(430, 680);
      document.documentElement.classList.toggle("dark", theme === "dark");
      document.documentElement.style.fontSize = `${scale}%`;
      const usage: ContextWindowSnapshot = {
        usedTokens: 95_000,
        maxTokens: 475_000,
        remainingTokens: 380_000,
        usedPercentage: 20,
        remainingPercentage: 80,
        updatedAt: "2026-10-12T00:00:00.000Z",
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
      const subagentConcurrency = {
        requested: 5,
        configured: 5,
        pending: false,
        source: "Chat override" as const,
      };
      const content = (
        requested: number | null | undefined,
        configured: number | null | undefined,
        inherited?: number,
        showSubagent = true,
        configuredAutoCompactTokenLimit?: number | null,
      ) => {
        const codexContextWindow = deriveCodexContextWindowPresentation({
          requested,
          configured,
          inherited,
          configuredAutoCompactTokenLimit,
          canApplyWhenIdle: true,
        });
        return layout === "rail" ? (
          <div style={{ width: 280, height: 600 }}>
            <SessionRail
              plan={null}
              usage={usage}
              rateLimits={rateLimits}
              subagentConcurrency={showSubagent ? subagentConcurrency : null}
              codexContextWindow={codexContextWindow}
              onShowInComposer={() => {}}
            />
          </div>
        ) : (
          <div style={{ width: 280 }}>
            <ContextWindowDetails
              usage={usage}
              rateLimits={rateLimits}
              layout={layout}
              subagentConcurrency={showSubagent ? subagentConcurrency : undefined}
              codexContextWindow={codexContextWindow}
            />
          </div>
        );
      };
      mounted = await render(content(1_000_000, 500_000));
      await expect
        .element(page.getByText("Context override: 500K → 1M when idle", { exact: true }))
        .toBeVisible();
      expect(document.querySelectorAll("[data-codex-context-window-details]")).toHaveLength(1);
      expect(document.querySelectorAll("[data-subagent-concurrency-details]")).toHaveLength(1);
      expect(
        document
          .querySelector("[data-subagent-concurrency-details]")!
          .compareDocumentPosition(document.querySelector("[data-codex-context-window-details]")!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      assertCompactPolicyRows();
      assertCompactContextFacts();
      await expect.element(page.getByText("(~900K compaction)", { exact: true })).toBeVisible();
      await expect
        .element(page.getByText("Total processed: 2.6m tokens", { exact: true }))
        .toBeVisible();
      await expect
        .element(page.getByText("Automatically compacts its context when needed.", { exact: true }))
        .toBeVisible();
      await expect.element(page.getByText("475k context used", { exact: true })).toBeVisible();
      expect(document.body.textContent).toContain("20%");
      if (layout === "rail") {
        const screenshotDirectory = import.meta.env.VITE_CODEX_CONTEXT_SCREENSHOT_DIR;
        if (typeof screenshotDirectory === "string" && screenshotDirectory.length > 0) {
          await settledRail();
          await page.screenshot({
            path: `${screenshotDirectory}/context-tasks-rail-${theme}-${scale}.png`,
          });
        }
      }
      const subagentHelp = page.getByRole("button", { name: "About subagent limits", exact: true });
      const contextHelp = page.getByRole("button", {
        name: "About context-window overrides",
        exact: true,
      });
      await expect.element(subagentHelp).toBeVisible();
      await expect.element(contextHelp).toBeVisible();
      subagentHelp.element().focus();
      await expect.element(subagentHelp).toHaveFocus();
      await userEvent.keyboard("{Tab}");
      await expect.element(contextHelp).toHaveFocus();
      await mounted.rerender(content(null, 500_000, 700_000));
      await expect
        .element(page.getByText("Context override: 500K → 700K when idle", { exact: true }))
        .toBeVisible();
      assertCompactPolicyRows();
      assertCompactContextFacts();
      await expect.element(page.getByText("(~630K compaction)", { exact: true })).toBeVisible();
      await mounted.rerender(content(null, 500_000));
      await expect
        .element(
          page.getByText("Context override: 500K → Codex default when idle", { exact: true }),
        )
        .toBeVisible();
      expect(document.querySelector("[data-codex-context-compaction-estimate]")).toBeNull();
      await mounted.rerender(content(null, undefined, 700_000));
      await expect
        .element(page.getByText("Context override: 700K · saved", { exact: true }))
        .toBeVisible();
      await expect.element(page.getByText("(~630K compaction)", { exact: true })).toBeVisible();
      await expect.element(page.getByText("475k context used", { exact: true })).toBeVisible();
      await mounted.rerender(content(null, null));
      expect(document.querySelector("[data-codex-context-window-details]")).toBeNull();
      assertSinglePolicyRow(
        document.querySelector<HTMLElement>("[data-subagent-concurrency-details]")!,
      );
      await mounted.rerender(content(700_000, 700_000, undefined, false, 700_000));
      expect(document.querySelector("[data-subagent-concurrency-details]")).toBeNull();
      await expect.element(page.getByText("Context override: 700K", { exact: true })).toBeVisible();
      const finalPolicySection = assertSinglePolicyRow(
        document.querySelector<HTMLElement>("[data-codex-context-window-details]")!,
      );
      await mounted.rerender(content(null, null, undefined, false));
      expect(document.querySelector("[data-codex-context-window-details]")).toBeNull();
      expect(document.querySelector("[data-subagent-concurrency-details]")).toBeNull();
      expect(finalPolicySection.isConnected).toBe(false);
      await expect.element(page.getByText("475k context used", { exact: true })).toBeVisible();
    },
  );

  it("keeps received quotas scrollable and both policy rows compact in a short scaled Tasks rail", async () => {
    await page.viewport(430, 680);
    document.documentElement.classList.add("dark");
    document.documentElement.style.fontSize = "130%";
    mounted = await render(
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: 280,
          height: 320,
          overflow: "hidden",
        }}
      >
        <SessionRail
          plan={{ steps: [{ step: "Still visible task", status: "inProgress" }] }}
          usage={null}
          rateLimits={{
            checkedAt: "2026-10-12T00:00:00.000Z",
            rateLimits: {},
            rateLimitsByLimitId: Object.fromEntries(
              Array.from({ length: 8 }, (_, index) => [
                `quota-${index}`,
                {
                  limitName: `Quota ${index}`,
                  primary: { usedPercent: index, windowDurationMins: 300, resetsAt: 1_788_278_880 },
                  credits: { hasCredits: true, unlimited: false, balance: "25" },
                },
              ]),
            ),
            rateLimitResetCredits: { availableCount: 2 },
          }}
          subagentConcurrency={{
            requested: 5,
            configured: 5,
            pending: false,
            source: "Chat override",
          }}
          codexContextWindow={deriveCodexContextWindowPresentation({
            requested: 1_000_000,
            configured: 500_000,
            canApplyWhenIdle: true,
          })}
          onShowInComposer={() => {}}
        />
      </div>,
    );
    await expect
      .element(page.getByText("Context override: 500K → 1M when idle", { exact: true }))
      .toBeVisible();
    const rail = await settledRail();
    const usage = rail.querySelector<HTMLElement>("[data-session-rail-usage]")!;
    const quotaScroll = rail.querySelector<HTMLElement>("[data-account-quota-scroll]")!;
    const resetCount = page.getByText("Usage limit resets available: 2", { exact: true });
    await expect.element(resetCount).toBeVisible();
    expect(quotaScroll.clientHeight).toBeGreaterThan(0);
    expect(quotaScroll.scrollHeight).toBeGreaterThan(quotaScroll.clientHeight);
    expect(getComputedStyle(quotaScroll).overflowY).toBe("auto");
    expect(quotaScroll.contains(resetCount.element())).toBe(false);
    expect(rail.querySelectorAll("[data-account-quota-bucket]")).toHaveLength(8);
    const subagent = rail.querySelector<HTMLElement>("[data-subagent-concurrency-details]")!;
    const context = rail.querySelector<HTMLElement>("[data-codex-context-window-details]")!;
    const gap = context.getBoundingClientRect().top - subagent.getBoundingClientRect().bottom;
    const rootRem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(Math.abs(gap - rootRem * 0.25)).toBeLessThanOrEqual(0.75);
    expect(context.parentElement).toBe(subagent.parentElement);
    expect(resetCount.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(
      subagent.parentElement!.getBoundingClientRect().top,
    );
    expect(context.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      rail.getBoundingClientRect().bottom + 1,
    );
    expect(usage.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      rail.getBoundingClientRect().bottom + 1,
    );
    const resetTop = resetCount.element().getBoundingClientRect().top;
    const policyTop = subagent.getBoundingClientRect().top;
    quotaScroll.scrollTop = quotaScroll.scrollHeight;
    expect(quotaScroll.scrollTop).toBeGreaterThan(0);
    expect(resetCount.element().getBoundingClientRect().top).toBe(resetTop);
    expect(subagent.getBoundingClientRect().top).toBe(policyTop);
    expect(rail.parentElement!.scrollHeight).toBeLessThanOrEqual(
      rail.parentElement!.clientHeight + 1,
    );
    await expect
      .element(page.getByRole("button", { name: "About subagent limits", exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "About context-window overrides", exact: true }))
      .toBeVisible();
    const screenshotDirectory = import.meta.env.VITE_CODEX_CONTEXT_SCREENSHOT_DIR;
    if (typeof screenshotDirectory === "string" && screenshotDirectory.length > 0) {
      await page.screenshot({
        path: `${screenshotDirectory}/context-tasks-rail-quotas-dark-130.png`,
      });
    }
  });

  it.each(["popover", "panel"] as const)(
    "shows the saved limit immediately and omits unknown limits in %s layout",
    async (layout) => {
      mounted = await render(
        <ContextWindowDetails
          usage={null}
          layout={layout}
          subagentConcurrency={{
            requested: 12,
            configured: 3,
            source: "Chat override",
            pending: true,
          }}
        />,
      );
      const details = document.querySelector<HTMLElement>(
        '[data-subagent-concurrency-details="true"]',
      );
      expect(details).not.toBeNull();
      expect(details?.textContent?.match(/Subagent limit/g)).toHaveLength(1);
      await expect
        .element(page.getByText("Subagent limit: 3 → 12 when idle", { exact: true }))
        .toBeVisible();
      expect(details?.textContent).toBe("Subagent limit: 3 → 12 when idle");
      await mounted.rerender(
        <ContextWindowDetails
          usage={null}
          layout={layout}
          subagentConcurrency={{
            requested: 5,
            configured: null,
            source: "Legacy instance configuration",
            pending: true,
          }}
        />,
      );
      await expect
        .element(page.getByText("Subagent limit: Provider default → 5 when idle", { exact: true }))
        .toBeVisible();
      expect(document.querySelector("[data-subagent-concurrency-details]")?.textContent).toBe(
        "Subagent limit: Provider default → 5 when idle",
      );
      for (const configured of [undefined, null, 8]) {
        await mounted.rerender(
          <ContextWindowDetails
            usage={null}
            layout={layout}
            subagentConcurrency={{
              requested: undefined,
              configured,
              source: "Provider / inherited default",
              pending: configured === 8,
            }}
          />,
        );
        if (configured === 8) {
          await expect
            .element(
              page.getByText("Subagent limit: 8 → Provider default when idle", { exact: true }),
            )
            .toBeVisible();
        } else {
          expect(document.querySelector("[data-subagent-concurrency-details]")).toBeNull();
          await expect
            .element(page.getByRole("heading", { name: "Subagent limit", exact: false }))
            .not.toBeInTheDocument();
          await expect.element(page.getByText("Waiting for usage from this chat.")).toBeVisible();
        }
      }
    },
  );

  it("keeps account-default transitions compact, including clear and unrecorded sessions", async () => {
    mounted = await render(
      <ContextWindowDetails
        usage={null}
        layout="panel"
        subagentConcurrency={{
          requested: 12,
          configured: 12,
          source: "Account default",
          pending: false,
        }}
      />,
    );
    await expect.element(page.getByText("Subagent limit: 12", { exact: true })).toBeVisible();
    await mounted.rerender(
      <ContextWindowDetails
        usage={null}
        layout="panel"
        subagentConcurrency={{
          requested: 24,
          configured: 12,
          source: "Account default",
          pending: true,
        }}
      />,
    );
    await expect
      .element(page.getByText("Subagent limit: 12 → 24 when idle", { exact: true }))
      .toBeVisible();
    expect(document.querySelectorAll("[data-subagent-concurrency-details]")).toHaveLength(1);
    await mounted.rerender(
      <ContextWindowDetails
        usage={null}
        layout="panel"
        subagentConcurrency={{
          requested: undefined,
          configured: 24,
          source: "Provider / inherited default",
          pending: true,
        }}
      />,
    );
    await expect
      .element(page.getByText("Subagent limit: 24 → Provider default when idle", { exact: true }))
      .toBeVisible();
    await mounted.rerender(
      <ContextWindowDetails
        usage={null}
        layout="panel"
        subagentConcurrency={{
          requested: 15,
          configured: undefined,
          source: "Account default",
          pending: false,
        }}
      />,
    );
    await expect
      .element(page.getByText("Subagent limit: 15 · saved", { exact: true }))
      .toBeVisible();
    expect(document.body.textContent).not.toContain("next turn");
  });

  it.each(["popover", "panel"] as const)(
    "puts the known count last in the %s summary, including zero",
    async (layout) => {
      mounted = await render(
        <ContextWindowDetails usage={null} rateLimits={rateLimits} layout={layout} />,
      );
      const count = page.getByText("Usage limit resets available: 0", { exact: true });
      await expect.element(count).toBeVisible();
      expect(count.element().parentElement?.lastElementChild).toBe(count.element());

      await mounted.rerender(
        <ContextWindowDetails
          usage={null}
          rateLimits={{ ...rateLimits, rateLimitResetCredits: { availableCount: 2 } }}
          layout={layout}
        />,
      );
      await expect.element(page.getByText("Usage limit resets available: 2")).toBeVisible();
    },
  );

  it("shows a known count without window usage and omits an unknown count", async () => {
    const countOnly = { ...rateLimits, rateLimits: { limitId: "codex" } };
    mounted = await render(<ContextWindowDetails usage={null} rateLimits={countOnly} />);
    await expect.element(page.getByText("Usage limit resets available: 0")).toBeVisible();

    await mounted.rerender(
      <ContextWindowDetails
        usage={null}
        rateLimits={{ ...countOnly, rateLimitResetCredits: null }}
      />,
    );
    await expect.element(page.getByText("Usage limit resets available: 0")).not.toBeInTheDocument();
    await expect.element(page.getByText("Waiting for usage from this chat.")).toBeVisible();
  });

  it.each(["popover", "panel"] as const)(
    "shows named-only quota, credit and spend details as inert text in %s layout",
    async (layout) => {
      const name = '<img src="missing" onerror="alert(1)">';
      const reason = "future_workspace_limit";
      mounted = await render(
        <div style={{ width: 260 }}>
          <ContextWindowDetails
            usage={null}
            layout={layout}
            rateLimits={{
              checkedAt: rateLimits.checkedAt,
              rateLimits: {},
              rateLimitsByLimitId: {
                unfamiliar: {
                  limitName: name,
                  secondary: { usedPercent: 0, windowDurationMins: 60, resetsAt: 1_780_000_000 },
                  credits: { hasCredits: true, unlimited: true, balance: null },
                  individualLimit: {
                    used: "0",
                    limit: "25.50",
                    remainingPercent: 100,
                    resetsAt: 1_780_000_000,
                  },
                  rateLimitReachedType: reason,
                },
                balance: {
                  limitName: "Credit-only bucket",
                  credits: { hasCredits: false, unlimited: false, balance: "0" },
                },
              },
              rateLimitResetCredits: { availableCount: 0 },
            }}
          />
        </div>,
      );
      await expect.element(page.getByText(name, { exact: true })).toBeVisible();
      await expect.element(page.getByText("100% left", { exact: true })).toBeVisible();
      await expect.element(page.getByText("Credits: Unlimited", { exact: true })).toBeVisible();
      await expect.element(page.getByText("Credits: 0 available", { exact: true })).toBeVisible();
      await expect
        .element(page.getByText("Credit balance:", { exact: false }))
        .not.toBeInTheDocument();
      await expect.element(page.getByText("Individual spend limit: 0 used of 25.50")).toBeVisible();
      await expect
        .element(page.getByText(`Limit reached: ${reason}`, { exact: true }))
        .toBeVisible();
      await expect.element(page.getByText("1h reset:", { exact: false })).toBeVisible();
      const quota = document.querySelector<HTMLElement>("[data-account-quota]")!;
      expect(quota.querySelectorAll("[data-account-quota-bucket]")).toHaveLength(2);
      expect(quota.querySelector("img")).toBeNull();
      expect(quota.textContent).not.toContain("Weekly reset");
      expect(quota.scrollWidth).toBeLessThanOrEqual(quota.clientWidth + 1);
      const count = page.getByText("Usage limit resets available: 0", { exact: true });
      expect(quota.lastElementChild).toBe(count.element());
    },
  );

  it("keeps null credit balance distinct from zero in a credits-only summary", async () => {
    mounted = await render(
      <ContextWindowDetails
        usage={null}
        rateLimits={{
          checkedAt: rateLimits.checkedAt,
          rateLimits: { credits: { hasCredits: true, unlimited: false, balance: null } },
        }}
      />,
    );
    await expect.element(page.getByText("Credits: Available (balance not reported)")).toBeVisible();
    await expect.element(page.getByText("Credits: 0 available")).not.toBeInTheDocument();
    await expect
      .element(page.getByText("Waiting for usage from this chat."))
      .not.toBeInTheDocument();
    await mounted.rerender(
      <ContextWindowDetails
        usage={null}
        rateLimits={{ checkedAt: rateLimits.checkedAt, rateLimits: { credits: null } }}
      />,
    );
    await expect.element(page.getByText("Waiting for usage from this chat.")).toBeVisible();
  });

  it.each(["popover", "panel"] as const)(
    "rounds displayed credits in the %s without changing the provider snapshot",
    async (layout) => {
      const snapshot: ServerProviderAccountRateLimits = {
        ...rateLimits,
        rateLimits: {
          credits: { hasCredits: true, unlimited: false, balance: "545.0317780000" },
        },
      };
      mounted = await render(
        <ContextWindowDetails usage={null} rateLimits={snapshot} layout={layout} />,
      );
      await expect
        .element(page.getByText("Credits: 545.03 available", { exact: true }))
        .toBeVisible();
      await expect
        .element(page.getByText("545.0317780000", { exact: false }))
        .not.toBeInTheDocument();
      expect(snapshot.rateLimits.credits?.balance).toBe("545.0317780000");
    },
  );
});
