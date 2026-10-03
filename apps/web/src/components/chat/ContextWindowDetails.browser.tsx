import "../../index.css";

import type { ServerProviderAccountRateLimits } from "@cafecode/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { ContextWindowDetails } from "./ContextWindowDetails";

const rateLimits: ServerProviderAccountRateLimits = {
  checkedAt: "2026-09-24T00:00:00.000Z",
  rateLimits: {
    limitId: "codex",
    primary: { usedPercent: 98, windowDurationMins: 300, resetsAt: 1_780_000_000 },
  },
  rateLimitResetCredits: { availableCount: 0 },
};

describe("ContextWindowDetails reset availability", () => {
  let mounted: Awaited<ReturnType<typeof render>> | undefined;
  afterEach(async () => {
    await mounted?.unmount();
    mounted = undefined;
  });

  it.each(["popover", "panel"] as const)(
    "shows selected, current, and pending concurrency without guessing provider enforcement in %s layout",
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
        .element(page.getByText("Selected for this chat: 12 at once", { exact: true }))
        .toBeVisible();
      await expect
        .element(page.getByText("Current session: 3 at once", { exact: true }))
        .toBeVisible();
      await expect
        .element(
          page.getByText(
            "Waiting to apply — applies before a new turn when the session can safely restart.",
            { exact: true },
          ),
        )
        .toBeVisible();
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
        .element(page.getByText("Account setting: 5 at once", { exact: true }))
        .toBeVisible();
      await expect
        .element(page.getByText("Current session: Provider-managed", { exact: true }))
        .toBeVisible();
      await expect.element(page.getByText(/^Waiting to apply/)).toBeVisible();
      await mounted.rerender(
        <ContextWindowDetails
          usage={null}
          layout={layout}
          subagentConcurrency={{
            requested: undefined,
            configured: undefined,
            source: "Provider / inherited default",
            pending: false,
          }}
        />,
      );
      await expect
        .element(page.getByText("Selected limit: Provider-managed", { exact: true }))
        .toBeVisible();
      await expect
        .element(page.getByText("Current session: Not recorded", { exact: true }))
        .toBeVisible();
      await expect.element(page.getByText(/^Waiting to apply/)).not.toBeInTheDocument();
      expect(document.body.textContent).not.toContain("Source:");
      expect(document.body.textContent).not.toContain("Native effective limit is not verified.");
    },
  );

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
    await expect.element(page.getByText("Waiting for usage from this thread.")).toBeVisible();
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
      .element(page.getByText("Waiting for usage from this thread."))
      .not.toBeInTheDocument();
    await mounted.rerender(
      <ContextWindowDetails
        usage={null}
        rateLimits={{ checkedAt: rateLimits.checkedAt, rateLimits: { credits: null } }}
      />,
    );
    await expect.element(page.getByText("Waiting for usage from this thread.")).toBeVisible();
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
