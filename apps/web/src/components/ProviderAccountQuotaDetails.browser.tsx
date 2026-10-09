import "../index.css";

import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { ProviderSessionQuotaReport } from "@cafecode/contracts";

import { formatCodexRateLimitPresentation } from "../lib/codexRateLimits";
import { ProviderAccountQuotaDetails } from "./ProviderAccountQuotaDetails";

describe("ProviderAccountQuotaDetails bounds", () => {
  let mounted: Awaited<ReturnType<typeof render>> | undefined;
  afterEach(async () => {
    await mounted?.unmount();
    mounted = undefined;
  });

  it.each(["compact", "popover", "settings"] as const)(
    "bounds all buckets in %s layout while keeping the reset count outside scrolling",
    async (layout) => {
      await page.viewport(1100, 800);
      const presentation = formatCodexRateLimitPresentation({
        checkedAt: "2026-09-29T00:00:00.000Z",
        rateLimits: {},
        rateLimitsByLimitId: Object.fromEntries(
          Array.from({ length: 20 }, (_, index) => [
            `quota-${index}`,
            {
              limitName: `Quota ${index}`,
              primary: { usedPercent: 25, windowDurationMins: 300 },
              credits: { hasCredits: false, unlimited: false, balance: "0" },
            },
          ]),
        ),
        rateLimitResetCredits: { availableCount: 0 },
      })!;
      mounted = await render(
        <div style={{ width: 300 }}>
          <ProviderAccountQuotaDetails presentation={presentation} layout={layout} />
        </div>,
      );
      const scroll = document.querySelector<HTMLElement>("[data-account-quota-scroll]")!;
      const count = page.getByText("Usage limit resets available: 0", { exact: true }).element();
      expect(document.querySelectorAll("[data-account-quota-bucket]")).toHaveLength(20);
      expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
      expect(scroll.clientHeight).toBeLessThanOrEqual(window.innerHeight * 0.4 + 1);
      expect(scroll.contains(count)).toBe(false);
      const countTop = count.getBoundingClientRect().top;
      scroll.scrollTop = scroll.scrollHeight;
      expect(count.getBoundingClientRect().top).toBe(countTop);
      expect(scroll.scrollWidth).toBeLessThanOrEqual(scroll.clientWidth + 1);
    },
  );

  it("keeps a reset-only settings window full width without inventing remaining usage", async () => {
    await page.viewport(1200, 800);
    const presentation = formatCodexRateLimitPresentation({
      checkedAt: "2026-09-29T00:00:00.000Z",
      rateLimits: {
        primary: { windowDurationMins: 10_080, resetsAt: 1_800_000_000 },
      },
    })!;
    mounted = await render(
      <div style={{ width: 1100 }}>
        <ProviderAccountQuotaDetails presentation={presentation} layout="settings" />
      </div>,
    );
    const window = document.querySelector<HTMLElement>('[data-account-quota-window="primary"]')!;
    const reset = window.querySelector("p")!;
    expect(reset.textContent).toContain("7d reset:");
    expect(reset.getBoundingClientRect().width).toBeCloseTo(
      window.getBoundingClientRect().width,
      0,
    );
    expect(window.textContent).not.toContain("% left");
    expect(document.querySelector("[data-account-quota-metadata]")).toBeNull();
  });

  it.each(["popover", "panel", "settings"] as const)(
    "shows every independent session row with provenance, local time and bounded scrolling in %s",
    async (layout) => {
      await page.viewport(700, 650);
      const report: ProviderSessionQuotaReport = {
        source: "claude-session",
        observedAt: new Date().toISOString(),
        meters: Array.from({ length: 24 }, (_, index) => ({
          kind: index === 0 ? "session" : "weekly_scoped",
          group: index === 0 ? "session" : "weekly",
          usedPercent: index === 0 ? 23.456 : 25,
          resetsAt: "2099-10-09T05:00:00.000Z",
          modelLabel: "Repeated model",
          surfaceLabel: "Native CLI",
          severity: "normal",
          isActive: index === 0,
        })),
        extraUsage: {
          enabled: false,
          monthlyLimit: 0,
          usedCredits: 0,
          usedPercent: 0,
          currency: null,
        },
      };
      mounted = await render(
        <div style={{ width: 270 }}>
          <ProviderAccountQuotaDetails
            layout={layout}
            sessionQuota={{ status: "available", report }}
          />
        </div>,
      );
      expect(document.querySelectorAll("[data-claude-quota-meter]")).toHaveLength(24);
      await expect.element(page.getByText("Session-reported · not account-verified")).toBeVisible();
      await expect.element(page.getByText("76.544% left", { exact: true })).toBeVisible();
      const local = new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(new Date(report.observedAt));
      expect(document.querySelector("[data-claude-session-quota]")?.textContent).toContain(local);
      const scroll = document.querySelector<HTMLElement>("[data-account-quota-scroll]")!;
      expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
      expect(scroll.clientHeight).toBeLessThanOrEqual(window.innerHeight * 0.4 + 1);
      expect(scroll.scrollWidth).toBeLessThanOrEqual(scroll.clientWidth + 1);
      scroll.focus();
      expect(document.activeElement).toBe(scroll);
      await userEvent.keyboard("{End}");
      await expect
        .poll(() => scroll.scrollTop + scroll.clientHeight)
        .toBeGreaterThanOrEqual(scroll.scrollHeight - 1);
      await expect.element(page.getByText("Extra usage: Disabled", { exact: true })).toBeVisible();
      expect(scroll.textContent).toContain("0 minor units (currency unavailable)");
      expect(document.querySelectorAll("[data-account-quota-scroll]")).toHaveLength(1);
      expect(document.querySelector("[data-claude-session-quota]")?.textContent).not.toContain(
        "Refresh",
      );
    },
  );

  it("distinguishes missing, empty and offline reports without reviving unbound sparse quota", async () => {
    mounted = await render(
      <ProviderAccountQuotaDetails sessionQuota={{ status: "unavailable", report: null }} />,
    );
    await expect.element(page.getByText("No session quota report available.")).toBeVisible();
    expect(document.body.textContent).not.toContain("0% left");
    const source = { source: "claude-session" as const, observedAt: new Date().toISOString() };
    await mounted.rerender(
      <ProviderAccountQuotaDetails
        sessionQuota={{ status: "available", report: { ...source, meters: null } }}
      />,
    );
    await expect.element(page.getByText("Quota meters unavailable in this report.")).toBeVisible();
    await mounted.rerender(
      <ProviderAccountQuotaDetails
        sessionQuota={{ status: "available", report: { ...source, meters: [] } }}
      />,
    );
    await expect.element(page.getByText("Claude reported no quota meters.")).toBeVisible();
    const name = '<img src=x onerror="evil()">';
    await mounted.rerender(
      <ProviderAccountQuotaDetails
        sessionQuota={{
          status: "available",
          report: {
            ...source,
            meters: [
              {
                kind: "future_kind",
                group: "future_group",
                modelLabel: name,
                usedPercent: 50,
                resetsAt: null,
                severity: "future_severity",
                isActive: false,
              },
            ],
          },
        }}
      />,
    );
    await expect.element(page.getByText(`future_kind · ${name}`, { exact: true })).toBeVisible();
    expect(document.querySelector("[data-claude-session-quota] img")).toBeNull();
    await mounted.rerender(
      <ProviderAccountQuotaDetails
        presentation={formatCodexRateLimitPresentation({
          checkedAt: source.observedAt,
          rateLimits: { primary: { windowDurationMins: 300, resetsAt: 1_800_000_000 } },
        })}
        sessionQuota={{ status: "offline", report: null }}
      />,
    );
    await expect
      .element(page.getByText("Session report unavailable while disconnected."))
      .toBeVisible();
    expect(document.body.textContent).not.toContain("5h reset:");
    expect(document.querySelector("[data-account-quota-window]")).toBeNull();
  });
});
