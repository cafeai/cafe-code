import "../index.css";

import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { ProviderSessionQuotaReport } from "@cafecode/contracts";

import { formatCodexRateLimitPresentation } from "../lib/codexRateLimits";
import { observeNativeInput } from "./nativeInput.browser.fixture";
import { ProviderAccountQuotaDetails } from "./ProviderAccountQuotaDetails";

describe("ProviderAccountQuotaDetails bounds", () => {
  let mounted: Awaited<ReturnType<typeof render>> | undefined;
  afterEach(async () => {
    await mounted?.unmount();
    mounted = undefined;
  });

  it("keeps each settings allowance and reset together while switching the selected model", async () => {
    await page.viewport(1100, 800);
    const report: ProviderSessionQuotaReport = {
      source: "claude-cli",
      observedAt: new Date().toISOString(),
      meters: [
        {
          kind: "session",
          group: "session",
          usedPercent: 57,
          resetsAt: "2099-10-16T22:40:00.143Z",
          severity: "normal",
          isActive: false,
        },
        {
          kind: "weekly_all",
          group: "weekly",
          usedPercent: 18,
          resetsAt: "2099-10-20T11:00:00.143Z",
          severity: "normal",
          isActive: false,
        },
        {
          kind: "weekly_scoped",
          group: "weekly",
          modelLabel: "Fable",
          usedPercent: 25,
          resetsAt: "2099-10-20T11:00:00.143Z",
          severity: "normal",
          isActive: false,
        },
      ],
      extraUsage: {
        enabled: true,
        monthlyLimit: 10_000,
        usedCredits: 2500,
        usedPercent: 25,
        currency: "USD",
      },
    };
    mounted = await render(
      <ProviderAccountQuotaDetails
        layout="settings"
        selectedModel="claude-sonnet-5-5"
        sessionQuota={{ status: "available", report }}
      />,
    );
    await expect.element(page.getByText("43% left", { exact: true })).toBeVisible();
    await expect.element(page.getByText("82% left", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Weekly", { exact: true })).toBeVisible();
    const session = page.getByRole("region", { name: "Session window quota", exact: true });
    const weekly = page.getByRole("region", { name: "Weekly quota", exact: true });
    await expect.element(session.getByText("43% left", { exact: true })).toBeVisible();
    await expect.element(session.getByText("Resets:", { exact: false })).toBeVisible();
    await expect.element(weekly.getByText("82% left", { exact: true })).toBeVisible();
    await expect.element(weekly.getByText("Resets:", { exact: false })).toBeVisible();
    await expect.element(page.getByText("Weekly · Fable", { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByText("25% of extra usage used", { exact: true })).toBeVisible();
    const text = document.querySelector("[data-claude-session-quota]")!.textContent!;
    for (const absent of [
      "all models",
      "Reported by",
      "Received:",
      "normal",
      "Provider headline",
      "Monthly limit",
      "USD",
    ])
      expect(text).not.toContain(absent);
    await expect
      .element(page.getByRole("button", { name: "Details", exact: true }))
      .not.toBeInTheDocument();
    if (import.meta.env.VITE_PROVIDER_SCREENSHOTS === "1") {
      const wasDark = document.documentElement.classList.contains("dark");
      document.documentElement.classList.add("dark");
      try {
        await page.screenshot({
          element: document.querySelector<HTMLElement>("[data-claude-session-quota]")!,
          path: "../../../../.explorations/claude-provider-minimal/usage-settings.png",
        });
      } finally {
        if (!wasDark) document.documentElement.classList.remove("dark");
      }
    }
    await mounted.rerender(
      <ProviderAccountQuotaDetails
        layout="settings"
        selectedModel="claude-fable-5-1"
        sessionQuota={{ status: "available", report }}
      />,
    );
    await expect.element(page.getByText("Weekly · Fable", { exact: true })).toBeVisible();
    await expect.element(page.getByText("75% left", { exact: true })).toBeVisible();
    await expect.element(page.getByText("82% left", { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByText("Weekly", { exact: true })).not.toBeInTheDocument();
    await mounted.rerender(
      <ProviderAccountQuotaDetails
        layout="settings"
        selectedModel="claude-opus-5-5"
        sessionQuota={{ status: "available", report }}
      />,
    );
    await expect.element(page.getByText("82% left", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Weekly · Fable", { exact: true })).not.toBeInTheDocument();
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
    "keeps applicable meters and inline extra usage in one bounded scroll owner in %s",
    async (layout) => {
      let observedScroll: HTMLElement | null = null;
      let screen: Awaited<ReturnType<typeof render>> | undefined;
      let published = false;
      const observation = observeNativeInput("quota-panel", () => observedScroll);
      let end: KeyboardEvent | undefined;
      const readEnd = (): KeyboardEvent | undefined => end;
      const observeEnd = (event: KeyboardEvent) => {
        if (event.key === "End" && event.target === observedScroll) end = event;
      };
      const retireEnd = () => {
        window.removeEventListener("keydown", observeEnd, true);
        end = undefined;
      };
      // Retire passive listeners even when the hard deadline bypasses finally.
      onTestFinished(observation.retire);
      onTestFinished(retireEnd);
      window.addEventListener("keydown", observeEnd, true);
      try {
        await page.viewport(700, 650);
        observation.assertActive();
        const report: ProviderSessionQuotaReport = {
          source: "claude-session",
          observedAt: new Date().toISOString(),
          meters: Array.from({ length: 24 }, (_, index) => ({
            kind: index === 0 ? "session" : "future_meter",
            group: index === 0 ? "session" : "weekly",
            usedPercent: index === 0 ? 23.456 : 25,
            resetsAt: "2099-10-09T05:00:00.000Z",
            modelLabel: "Repeated model",
            surfaceLabel: "Native CLI",
            severity: "normal",
            isActive: index === 0,
          })),
          extraUsage: {
            enabled: true,
            monthlyLimit: 100,
            usedCredits: 25,
            usedPercent: 25,
            currency: null,
          },
        };
        screen = await render(
          <div style={{ width: 270 }}>
            <ProviderAccountQuotaDetails
              layout={layout}
              sessionQuota={{ status: "available", report }}
            />
          </div>,
        );
        observation.assertActive();
        mounted = screen;
        published = true;
        expect(document.querySelectorAll("[data-claude-quota-meter]")).toHaveLength(24);
        await expect.element(page.getByText("76.544% left", { exact: true })).toBeVisible();
        observation.assertActive();
        const scroll = document.querySelector<HTMLElement>("[data-account-quota-scroll]")!;
        observedScroll = scroll;
        expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
        expect(scroll.clientHeight).toBeLessThanOrEqual(window.innerHeight * 0.4 + 1);
        expect(scroll.scrollWidth).toBeLessThanOrEqual(scroll.clientWidth + 1);
        scroll.focus();
        expect(document.activeElement).toBe(scroll);
        observation.mark("ready");
        observation.mark("before-input");
        await userEvent.keyboard("{End}");
        observation.assertActive();
        observation.mark("after-input");
        // Inspect the original event only after its native command completes.
        // Intentional interception must still deliver the original bottom/extra
        // usage behavior below; this receipt is not a substitute for movement.
        const receivedEnd = readEnd();
        expect(receivedEnd?.isTrusted).toBe(true);
        expect(receivedEnd?.target).toBe(scroll);
        expect(receivedEnd?.defaultPrevented).toBe(true);
        await expect
          .poll(() => scroll.scrollTop + scroll.clientHeight)
          .toBeGreaterThanOrEqual(scroll.scrollHeight - 1);
        observation.assertActive();
        await expect
          .element(page.getByText("25% of extra usage used", { exact: true }))
          .toBeVisible();
        observation.assertActive();
        expect(document.querySelectorAll("[data-account-quota-scroll]")).toHaveLength(1);
        expect(document.querySelector("[data-claude-session-quota]")?.textContent).not.toContain(
          "Refresh",
        );
        observation.complete();
      } catch (error) {
        observation.fail();
        throw error;
      } finally {
        retireEnd();
        observation.retire();
        // The late continuation can retire only its own render. If afterEach
        // already unmounted a published screen, never touch a later case's root.
        if (screen && (!published || mounted === screen)) {
          await screen.unmount();
          if (mounted === screen) mounted = undefined;
        }
      }
    },
  );

  it("leaves modified End on the quota region to native selection behavior", async ({
    onTestFinished,
    signal,
  }) => {
    let retired = false;
    let view: Awaited<ReturnType<typeof render>> | undefined;
    let pendingRender: ReturnType<typeof render> | undefined;
    let end: KeyboardEvent | undefined;
    const readEnd = (): KeyboardEvent | undefined => end;
    const pending = new Set<Promise<unknown>>();
    let cleanupPromise: Promise<void> | undefined;
    const requireActive = () => {
      if (retired) throw new Error("Quota modified-End fixture retired");
    };
    const own = <T,>(operation: () => Promise<T>): Promise<T> => {
      requireActive();
      const result = operation();
      pending.add(result);
      void result.then(
        () => pending.delete(result),
        () => pending.delete(result),
      );
      return result;
    };
    const observe = (event: KeyboardEvent) => {
      if (!retired && event.key === "End") end = event;
    };
    const retire = () => {
      retired = true;
      end = undefined;
      window.removeEventListener("keydown", observe, true);
    };
    const cleanup = () => {
      if (cleanupPromise) return cleanupPromise;
      retire();
      cleanupPromise = (async () => {
        try {
          // Retire admission first, join exact admitted native/render work, and
          // only then unmount this fixture's own root. Never destroy a later test.
          await Promise.allSettled([...pending]);
          const mounted = view ?? (await pendingRender);
          await mounted?.unmount();
        } finally {
          signal?.removeEventListener("abort", retire);
        }
      })();
      return cleanupPromise;
    };
    onTestFinished(cleanup);
    signal?.addEventListener("abort", retire, { once: true });
    if (signal?.aborted) retire();
    try {
      await own(() => page.viewport(700, 650));
      requireActive();
      const report: ProviderSessionQuotaReport = {
        source: "claude-session",
        observedAt: new Date().toISOString(),
        meters: Array.from({ length: 24 }, () => ({
          kind: "future_meter",
          group: "weekly",
          usedPercent: 25,
          resetsAt: null,
          severity: "normal",
          isActive: false,
        })),
      };
      pendingRender = own(() =>
        render(
          <div style={{ width: 270 }}>
            <ProviderAccountQuotaDetails
              layout="panel"
              sessionQuota={{ status: "available", report }}
            />
          </div>,
        ),
      );
      view = await pendingRender;
      requireActive();
      const scroll = document.querySelector<HTMLElement>("[data-account-quota-scroll]")!;
      expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
      scroll.focus();
      expect(document.activeElement).toBe(scroll);
      window.addEventListener("keydown", observe, true);
      await own(() => userEvent.keyboard("{Shift>}{End}{/Shift}"));
      requireActive();
      const receivedEnd = readEnd();
      expect(receivedEnd?.isTrusted).toBe(true);
      expect(receivedEnd?.target).toBe(scroll);
      expect(receivedEnd?.shiftKey).toBe(true);
      expect(receivedEnd?.defaultPrevented).toBe(false);
      // This deliberately unhandled native selection command may move or select
      // text. Its UA effect is not the quota controller's non-interception proof.
    } finally {
      await cleanup();
    }
  });

  it("distinguishes missing, empty and offline reports without reviving unbound sparse quota", async () => {
    mounted = await render(
      <ProviderAccountQuotaDetails sessionQuota={{ status: "unavailable", report: null }} />,
    );
    await expect.element(page.getByText("Claude limits are unavailable.")).toBeVisible();
    expect(document.querySelector("[data-claude-session-quota]")?.textContent).toBe(
      "Claude limits are unavailable.",
    );
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
    await expect.element(page.getByText("Claude limits are unavailable.")).toBeVisible();
    expect(document.querySelector("[data-claude-session-quota]")?.textContent).toBe(
      "Claude limits are unavailable.",
    );
    expect(document.body.textContent).not.toContain("5h reset:");
    expect(document.querySelector("[data-account-quota-window]")).toBeNull();
  });
});
