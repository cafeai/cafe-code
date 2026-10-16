import "../../index.css";

import type { UsageStatsDay } from "@cafecode/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";

import { applyInterfaceScalePercent } from "../../interfaceScale";
import { ActivityHeatmap } from "./ActivityHeatmap";

function activity(day: string, generatingMs = 0): UsageStatsDay {
  return {
    day,
    generatingMs,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    userMessages: 0,
  };
}

function requiredElement(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  expect(element).not.toBeNull();
  return element!;
}

function selectedDays(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-activity-in-range="true"]'));
}

function cell(day: string): HTMLElement {
  return requiredElement(`[data-activity-day="${day}"]`);
}

async function hoverCell(day: string): Promise<HTMLElement> {
  // A synthetic pointerover does not move Chromium's real pointer. Scrolling
  // a virtual calendar underneath that pointer can deliver a later trusted
  // pointerover for another day and correctly replace the synthetic tooltip.
  // Let Playwright wait for the target's layout stability and move the native
  // pointer to that exact cell, including historic cells that need scrolling.
  await page.elementLocator(cell(day)).hover();
  await vi.waitFor(() =>
    expect(
      document.querySelector('[role="tooltip"]')?.getAttribute("data-activity-tooltip-day"),
    ).toBe(day),
  );
  return requiredElement('[role="tooltip"]');
}

describe("ActivityHeatmap selected calendars", () => {
  let mounted: Awaited<ReturnType<typeof render>> | null = null;
  let originalViewport = { height: window.innerHeight, width: window.innerWidth };
  let originalRootFontSize = "";
  let originalRootFontPriority = "";

  beforeEach(() => {
    originalViewport = { height: window.innerHeight, width: window.innerWidth };
    originalRootFontSize = document.documentElement.style.getPropertyValue("font-size");
    originalRootFontPriority = document.documentElement.style.getPropertyPriority("font-size");
  });

  afterEach(async () => {
    await mounted?.unmount();
    mounted = null;
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (originalRootFontSize) {
      document.documentElement.style.setProperty(
        "font-size",
        originalRootFontSize,
        originalRootFontPriority,
      );
    } else {
      document.documentElement.style.removeProperty("font-size");
    }
    if (
      window.innerWidth !== originalViewport.width ||
      window.innerHeight !== originalViewport.height
    ) {
      await page.viewport(originalViewport.width, originalViewport.height);
    }
  });

  it("hovers the requested day after scrolling moves the calendar under a stationary pointer", async () => {
    mounted = await render(
      <ActivityHeatmap days={[]} bounds={{ startDay: "2022-01-01", endDay: "2026-07-21" }} />,
    );
    expect((await hoverCell("2022-01-01")).textContent).toContain("No generating time");
    const scroller = requiredElement('[data-activity-heatmap-scroll="true"]');
    scroller.scrollLeft = scroller.scrollWidth;
    await vi.waitFor(() =>
      expect(document.querySelector('[data-activity-day="2026-07-21"]')).not.toBeNull(),
    );
    expect((await hoverCell("2026-07-21")).textContent).toContain("Jul 21, 2026");
  });

  it("fills sparse dates with zeroes and replaces today's fetched value exactly once", async () => {
    mounted = await render(
      <ActivityHeatmap
        days={[
          activity("2026-03-07", 1_000_000),
          activity("2026-03-08", 1_000),
          activity("2026-03-14", 6_000),
          activity("2026-03-15", 1_000_000),
        ]}
        today={activity("2026-03-14", 2_000)}
        bounds={{ startDay: "2026-03-08", endDay: "2026-03-14" }}
      />,
    );

    expect(selectedDays().map((element) => element.dataset.activityDay)).toEqual([
      "2026-03-08",
      "2026-03-09",
      "2026-03-10",
      "2026-03-11",
      "2026-03-12",
      "2026-03-13",
      "2026-03-14",
    ]);
    expect((await hoverCell("2026-03-14")).textContent).toContain("2s generating");
    expect((await hoverCell("2026-03-10")).textContent).toContain("No generating time");
    expect((await hoverCell("2026-03-08")).textContent).toContain("Sun");
  });

  it("shows all history older than 26 weeks and ignores activity in alignment padding", async () => {
    mounted = await render(
      <ActivityHeatmap
        days={[
          activity("2021-12-31", 60_000),
          activity("2022-01-01", 1_000),
          activity("2026-07-21", 2_000),
          activity("2026-07-22", 60_000),
        ]}
        bounds={{ startDay: "2022-01-01", endDay: "2026-07-21" }}
      />,
    );

    expect(requiredElement('[role="img"]').dataset.activityRangeDayCount).toBe("1663");
    expect(selectedDays().length).toBeLessThan(500);
    expect(selectedDays()[0]?.dataset.activityDay).toBe("2022-01-01");
    expect((await hoverCell("2022-01-01")).textContent).toContain("1s generating");
    expect(cell("2021-12-31").dataset.activityInRange).toBe("false");
    const scroller = requiredElement('[data-activity-heatmap-scroll="true"]');
    scroller.scrollLeft = scroller.scrollWidth;
    await vi.waitFor(() =>
      expect(document.querySelector('[data-activity-day="2026-07-21"]')).not.toBeNull(),
    );
    expect(selectedDays().at(-1)?.dataset.activityDay).toBe("2026-07-21");
    expect(cell("2026-07-22").dataset.activityInRange).toBe("false");
  });

  it("retains scroll position for live updates and resets it for a new selected range", async () => {
    const bounds = { startDay: "2022-01-01", endDay: "2026-07-21" };
    mounted = await render(
      <ActivityHeatmap days={[]} bounds={bounds} today={activity("2026-07-21", 1_000)} />,
    );
    const scroller = requiredElement('[data-activity-heatmap-scroll="true"]');
    scroller.scrollLeft = scroller.scrollWidth;
    await vi.waitFor(() =>
      expect(document.querySelector('[data-activity-day="2026-07-21"]')).not.toBeNull(),
    );
    const previousScrollLeft = scroller.scrollLeft;
    expect((await hoverCell("2026-07-21")).textContent).toContain("1s generating");
    await mounted.rerender(
      <ActivityHeatmap days={[]} bounds={{ ...bounds }} today={activity("2026-07-21", 2_000)} />,
    );
    expect(scroller.scrollLeft).toBe(previousScrollLeft);
    expect(requiredElement('[role="tooltip"]').textContent).toContain("2s generating");
    await mounted.rerender(
      <ActivityHeatmap days={[]} bounds={{ startDay: "2026-07-15", endDay: "2026-07-21" }} />,
    );
    expect(selectedDays()).toHaveLength(7);
    expect(scroller.scrollLeft).toBe(0);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it("does not remap or rescan historical activity when only the live value changes", async () => {
    const days = [activity("0100-01-01", 5_000), activity("2026-07-21", 9_000)];
    const mapDays = vi.spyOn(days, "map");
    const originalIterator = Map.prototype[Symbol.iterator];
    let historyScans = 0;
    vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function (
      this: Map<unknown, unknown>,
    ) {
      // Identify this exact synthetic history map. Other React/browser maps
      // must retain their normal iterator and do not contribute to the count.
      if (this.has("0100-01-01") && this.has("2026-07-21")) historyScans += 1;
      return originalIterator.call(this);
    });
    const bounds = { startDay: "0100-01-01", endDay: "2026-07-21" };
    mounted = await render(
      <ActivityHeatmap days={days} bounds={bounds} today={activity("2026-07-21", 1_000)} />,
    );
    expect(historyScans).toBeGreaterThan(0);
    const initialScans = historyScans;
    const initialMappings = mapDays.mock.calls.length;
    const scroller = requiredElement('[data-activity-heatmap-scroll="true"]');
    scroller.scrollLeft = scroller.scrollWidth;
    await vi.waitFor(() =>
      expect(document.querySelector('[data-activity-day="2026-07-21"]')).not.toBeNull(),
    );
    for (const generatingMs of [2_000, 4_000, 10_000]) {
      await mounted.rerender(
        <ActivityHeatmap
          days={days}
          bounds={{ ...bounds }}
          today={activity("2026-07-21", generatingMs)}
        />,
      );
    }
    expect(mapDays).toHaveBeenCalledTimes(initialMappings);
    expect(historyScans).toBe(initialScans);
    expect((await hoverCell("2026-07-21")).textContent).toContain("10s generating");
  });

  it("retains an exceptionally old valid history with bounded calendar allocation", async () => {
    await page.viewport(320, 800);
    applyInterfaceScalePercent(130);
    mounted = await render(
      <section className="min-w-0 p-4" style={{ width: "100%" }}>
        <ActivityHeatmap
          days={[activity("0000-01-01", 1_000), activity("2026-07-21", 3_000)]}
          bounds={{ startDay: "0000-01-01", endDay: "2026-07-21" }}
        />
      </section>,
    );
    const scroller = requiredElement('[data-activity-heatmap-scroll="true"]');
    const calendar = requiredElement('[role="img"]');
    expect(Number(calendar.dataset.activityRangeDayCount)).toBeGreaterThan(700_000);
    expect(selectedDays().length).toBeLessThan(200);
    expect(calendar.children.length).toBeLessThan(30);
    expect((await hoverCell("0000-01-01")).textContent).toContain("1s generating");
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);

    scroller.scrollLeft = scroller.scrollWidth / 2;
    await vi.waitFor(() => {
      const firstYear = Number(selectedDays()[0]?.dataset.activityDay?.slice(0, 4));
      expect(firstYear).toBeGreaterThan(1_000);
      expect(firstYear).toBeLessThan(1_030);
    });
    expect(selectedDays().length).toBeLessThan(200);
    scroller.scrollLeft = scroller.scrollWidth;
    await vi.waitFor(() =>
      expect(document.querySelector('[data-activity-day="2026-07-21"]')).not.toBeNull(),
    );
    expect((await hoverCell("2026-07-21")).textContent).toContain("3s generating");
    expect(selectedDays().length).toBeLessThan(200);
    scroller.scrollLeft = 0;
    await vi.waitFor(() =>
      expect(document.querySelector('[data-activity-day="0000-01-01"]')).not.toBeNull(),
    );
    expect((await hoverCell("0000-01-01")).textContent).toContain("1s generating");
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  });

  it.each([
    [320, 80],
    [320, 130],
    [768, 100],
    [768, 130],
  ] as const)("bounds long-history scrolling at %ipx and %i%% scale", async (width, scale) => {
    await page.viewport(width, 800);
    applyInterfaceScalePercent(scale);
    mounted = await render(
      <section
        data-heatmap-panel="true"
        className="min-w-0 rounded-xl border p-4"
        style={{ width: "calc(100vw - 2rem)", maxWidth: "42rem", margin: "1rem auto" }}
      >
        <ActivityHeatmap
          days={[activity("2022-01-01", 1_000)]}
          bounds={{ startDay: "2022-01-01", endDay: "2026-07-21" }}
        />
      </section>,
    );

    const panel = requiredElement('[data-heatmap-panel="true"]');
    const scroller = requiredElement('[data-activity-heatmap-scroll="true"]');
    expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1);
    expect(scroller.getBoundingClientRect().right).toBeLessThanOrEqual(
      panel.getBoundingClientRect().right,
    );
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    expect(scroller.scrollWidth).toBeGreaterThan(scroller.clientWidth);
    expect(getComputedStyle(scroller).overflowX).toBe("auto");
    // Scrolling reaches today's exact cell without creating document overflow.
    scroller.scrollLeft = scroller.scrollWidth;
    await vi.waitFor(() =>
      expect(document.querySelector('[data-activity-day="2026-07-21"]')).not.toBeNull(),
    );
    const lastCell = cell("2026-07-21").getBoundingClientRect();
    expect(lastCell.right).toBeLessThanOrEqual(scroller.getBoundingClientRect().right + 1);
    expect(lastCell.left).toBeGreaterThanOrEqual(scroller.getBoundingClientRect().left);
    const visibleCell = selectedDays().find((element) => {
      const box = element.getBoundingClientRect();
      return (
        box.left >= scroller.getBoundingClientRect().left + 40 &&
        box.left <= scroller.getBoundingClientRect().left + 70
      );
    });
    expect(visibleCell).toBeDefined();
    const tooltip = await hoverCell(visibleCell!.dataset.activityDay!);
    expect(tooltip.getBoundingClientRect().left).toBeGreaterThanOrEqual(
      scroller.getBoundingClientRect().left,
    );
    expect(tooltip.getBoundingClientRect().right).toBeLessThanOrEqual(
      scroller.getBoundingClientRect().right,
    );
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  });

  it.each([100] as const)(
    "keeps responsive calendars and legends inside a 320px panel at %i%% scale",
    async (scale) => {
      await page.viewport(320, 800);
      applyInterfaceScalePercent(scale);
      mounted = await render(
        <section
          data-heatmap-panel="true"
          className="min-w-0 rounded-xl border p-4"
          style={{ width: "calc(100vw - 2rem)", margin: "1rem auto" }}
        >
          <ActivityHeatmap
            layout="responsive"
            days={[activity("2026-10-03", 2_000)]}
            bounds={{ startDay: "2026-07-05", endDay: "2026-10-03" }}
          />
        </section>,
      );
      const panel = requiredElement('[data-heatmap-panel="true"]');
      const scroller = requiredElement('[data-activity-heatmap-scroll="true"]');
      const legend = requiredElement('[data-activity-heatmap-legend="true"]');
      await vi.waitFor(() => {
        expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1);
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
        expect(legend.getBoundingClientRect().width).toBeLessThanOrEqual(scroller.clientWidth + 1);
      });
      const first = cell("2026-07-05").getBoundingClientRect();
      expect(first.width).toBeGreaterThanOrEqual((14 * scale) / 100 - 0.1);
      expect(first.width).toBeLessThanOrEqual((24 * scale) / 100 + 0.1);
      if (scroller.scrollWidth > scroller.clientWidth + 1) {
        scroller.scrollLeft = scroller.scrollWidth;
      }
      const tooltip = await hoverCell("2026-10-03");
      expect(tooltip.textContent).toContain("2s generating");
      expect(tooltip.getBoundingClientRect().left).toBeGreaterThanOrEqual(
        scroller.getBoundingClientRect().left - 1,
      );
      expect(tooltip.getBoundingClientRect().right).toBeLessThanOrEqual(
        scroller.getBoundingClientRect().right + 1,
      );
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    },
  );

  it("adapts a responsive calendar on wide-to-narrow-to-wide resize and hovers exact cells", async () => {
    await page.viewport(900, 800);
    applyInterfaceScalePercent(100);
    mounted = await render(
      <section
        className="min-w-0 border p-4"
        style={{ width: "calc(100vw - 2rem)", margin: "1rem auto" }}
      >
        <ActivityHeatmap
          layout="responsive"
          days={[activity("2026-10-03", 3_000)]}
          bounds={{ startDay: "2026-07-05", endDay: "2026-10-03" }}
        />
      </section>,
    );
    const calendar = requiredElement('[role="img"]');
    const scroller = requiredElement('[data-activity-heatmap-scroll="true"]');
    await vi.waitFor(() =>
      expect(cell("2026-10-03").getBoundingClientRect().width).toBeCloseTo(24, 1),
    );
    expect((await hoverCell("2026-10-03")).textContent).toContain("3s generating");
    await page.viewport(320, 800);
    await vi.waitFor(() => {
      const size = cell("2026-10-03").getBoundingClientRect().width;
      expect(size).toBeLessThan(24);
      expect(size).toBeGreaterThanOrEqual(13.9);
      // Resizing invalidates captured cell coordinates. A stale tooltip must
      // disappear until the pointer deliberately enters a newly laid-out cell.
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    });
    const narrowTooltip = await hoverCell("2026-10-03");
    expect(narrowTooltip.textContent).toContain("Oct 3, 2026");
    expect(narrowTooltip.getBoundingClientRect().right).toBeLessThanOrEqual(
      scroller.getBoundingClientRect().right + 1,
    );
    await page.viewport(900, 800);
    await vi.waitFor(() => {
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
    });
    expect(requiredElement('[role="img"]')).toBe(calendar);
    expect(requiredElement('[data-activity-heatmap-scroll="true"]')).toBe(scroller);
    expect(scroller.scrollLeft).toBe(0);
    expect((await hoverCell("2026-10-03")).textContent).toContain("3s generating");
  });

  it.each([
    ["2026-07-05", "2026-07-11"],
    ["2026-07-15", "2026-07-21"],
  ] as const)(
    "keeps a short responsive history compact from %s through %s",
    async (startDay, endDay) => {
      await page.viewport(1_024, 800);
      applyInterfaceScalePercent(100);
      mounted = await render(
        <section
          className="min-w-0 p-4"
          style={{ width: "calc(100vw - 2rem)", margin: "1rem auto" }}
        >
          <ActivityHeatmap layout="responsive" days={[]} bounds={{ startDay, endDay }} />
        </section>,
      );
      const scroller = requiredElement('[data-activity-heatmap-scroll="true"]');
      const legend = requiredElement('[data-activity-heatmap-legend="true"]');
      expect(selectedDays()).toHaveLength(7);
      expect(legend.getBoundingClientRect().width).toBeGreaterThanOrEqual(9 * 16 - 1);
      expect(scroller.scrollWidth).toBeLessThanOrEqual(scroller.clientWidth + 1);
    },
  );

  it("keeps responsive virtualized history compact and preserves scroll on live updates", async () => {
    await page.viewport(768, 800);
    applyInterfaceScalePercent(100);
    const bounds = { startDay: "2022-01-01", endDay: "2026-07-21" };
    const content = (generatingMs: number) => (
      <section
        className="min-w-0 border p-4"
        style={{ width: "calc(100vw - 2rem)", margin: "1rem auto" }}
      >
        <ActivityHeatmap
          layout="responsive"
          days={[]}
          bounds={{ ...bounds }}
          today={activity(bounds.endDay, generatingMs)}
        />
      </section>
    );
    mounted = await render(content(1_000));
    const scroller = requiredElement('[data-activity-heatmap-scroll="true"]');
    expect(scroller.getAttribute("role")).toBe("region");
    expect(selectedDays().length).toBeLessThan(500);
    expect(scroller.scrollWidth).toBeGreaterThan(scroller.clientWidth);
    scroller.scrollLeft = scroller.scrollWidth;
    await vi.waitFor(() =>
      expect(document.querySelector(`[data-activity-day="${bounds.endDay}"]`)).not.toBeNull(),
    );
    const previousScrollLeft = scroller.scrollLeft;
    expect((await hoverCell(bounds.endDay)).textContent).toContain("1s generating");
    await mounted.rerender(content(2_000));
    expect(requiredElement('[data-activity-heatmap-scroll="true"]')).toBe(scroller);
    expect(scroller.scrollLeft).toBe(previousScrollLeft);
    expect(requiredElement('[role="tooltip"]').textContent).toContain("2s generating");
    expect(selectedDays().length).toBeLessThan(500);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  });
});
