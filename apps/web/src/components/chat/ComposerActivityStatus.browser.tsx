import "../../index.css";

import type { ComponentProps } from "react";
import { cdp, page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { applyInterfaceScalePercent } from "../../interfaceScale";
import { ComposerActivityStatus } from "./ComposerActivityStatus";
import type { ChatActivityPresentation } from "./chatActivity";

const WORKING: ChatActivityPresentation = {
  label: "Running command…",
  attention: false,
  taskCount: 1,
  agentCount: 0,
  canInspect: true,
};

function Fixture(props: ComponentProps<typeof ComposerActivityStatus> & { width?: number }) {
  return (
    <section className="bg-background p-3 text-foreground" style={{ width: props.width ?? 360 }}>
      <button type="button">Before activity</button>
      <div data-activity-fixture>
        <ComposerActivityStatus
          activity={props.activity}
          turnStartedAt={props.turnStartedAt}
          generationRate={props.generationRate}
          onOpenTasks={props.onOpenTasks}
        />
      </div>
      <button type="button">After activity</button>
    </section>
  );
}

function activityElement(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-composer-activity-status="true"]');
  expect(element).not.toBeNull();
  return element!;
}

function elapsedWrapper(): HTMLElement {
  const element = document.querySelector<HTMLElement>("[data-activity-elapsed-revealed]");
  expect(element).not.toBeNull();
  return element!;
}

function rateElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-activity-generation-rate="true"]');
}

function elapsedTimer(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[role="timer"]');
  expect(element).not.toBeNull();
  return element!;
}

function elapsedSeconds(): number {
  const text = elapsedTimer().textContent ?? "";
  const parts = [...text.matchAll(/(\d+)(h|m|s)/g)];
  expect(parts.length).toBeGreaterThan(0);
  return parts.reduce(
    (seconds, part) =>
      seconds + Number(part[1]) * (part[2] === "h" ? 3600 : part[2] === "m" ? 60 : 1),
    0,
  );
}

async function expectElapsedDescription(): Promise<void> {
  const line = activityElement();
  const descriptionId = line.getAttribute("aria-describedby");
  expect(descriptionId).not.toBeNull();
  const description = document.getElementById(descriptionId!);
  expect(description).not.toBeNull();
  expect(elapsedTimer().contains(description)).toBe(true);
  expect(description!.textContent).toMatch(/^Elapsed turn time: \d+(?:h|m|s)/);
  // The reference must expose the actual duration, not only the timer's static
  // accessible label. This verifies the browser's accessible description too.
  await expect.element(line).toHaveAccessibleDescription(description!.textContent!);
}

async function expectRevealed(revealed: boolean): Promise<void> {
  // Poll real transition geometry, never advance a fake browser clock or relax
  // the existing fixture deadline to make an incomplete animation pass.
  await vi.waitFor(() => {
    const wrapper = elapsedWrapper();
    expect(wrapper.dataset.activityElapsedRevealed).toBe(String(revealed));
    expect(wrapper.getAttribute("aria-hidden")).toBe(String(!revealed));
    expect(getComputedStyle(wrapper).opacity).toBe(revealed ? "1" : "0");
    const width = wrapper.getBoundingClientRect().width;
    if (revealed) expect(width).toBeGreaterThan(10);
    else expect(width).toBeLessThanOrEqual(1);
  });
}

describe("composer activity hover elapsed time", () => {
  let mounted: Awaited<ReturnType<typeof render>> | undefined;
  const originalViewport = { width: window.innerWidth, height: window.innerHeight };
  const originalFontSize = document.documentElement.style.fontSize;
  const originalClassName = document.documentElement.className;

  beforeEach(async () => {
    await page.viewport(480, 640);
    document.documentElement.classList.remove("dark");
    applyInterfaceScalePercent(100);
    await cdp().send("Emulation.setEmulatedMedia", { features: [] });
    // A real pointer can otherwise remain over the previous test's status
    // coordinates. Move it outside before mounting, rather than misclassify
    // that genuine initial hover as a hidden timer or mock mouse semantics.
    await cdp().send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: window.innerWidth - 1,
      y: window.innerHeight - 1,
    });
  });

  afterEach(async () => {
    // Retire the real component before restoring spies, so cleanup is both
    // observed by its regression and actually delivered to native timers.
    await mounted?.unmount();
    mounted = undefined;
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    document.documentElement.className = originalClassName;
    document.documentElement.style.fontSize = originalFontSize;
    await cdp().send("Emulation.setEmulatedMedia", { features: [] });
    await page.viewport(originalViewport.width, originalViewport.height);
  });

  it("collapses at rest, reveals on real hover, and hides without changing line height", async () => {
    const onOpenTasks = vi.fn();
    mounted = await render(
      <Fixture
        activity={WORKING}
        turnStartedAt={new Date(Date.now() - 67_000).toISOString()}
        onOpenTasks={onOpenTasks}
      />,
    );
    await page.getByRole("button", { name: "Before activity" }).hover();
    await expectRevealed(false);
    const line = activityElement();
    const collapsedHeight = line.getBoundingClientRect().height;
    expect(line.getAttribute("aria-describedby")).toBeNull();
    expect(elapsedTimer().getAttribute("aria-live")).toBe("off");
    expect(elapsedTimer().getAttribute("aria-label")).toBe("Elapsed turn time");

    await page.getByRole("button", { name: "Running command…. Show tasks" }).hover();
    await expectRevealed(true);
    await expectElapsedDescription();
    expect(elapsedSeconds()).toBeGreaterThanOrEqual(67);
    expect(Math.abs(line.getBoundingClientRect().height - collapsedHeight)).toBeLessThanOrEqual(1);
    expect(onOpenTasks).not.toHaveBeenCalled();

    await page.getByRole("button", { name: "After activity" }).hover();
    await expectRevealed(false);
    expect(line.getAttribute("aria-describedby")).toBeNull();
    expect(onOpenTasks).not.toHaveBeenCalled();
  });

  it("reveals the measured generation speed beside the elapsed time", async () => {
    const onOpenTasks = vi.fn();
    const start = new Date(Date.now() - 30_000).toISOString();
    mounted = await render(
      <Fixture
        activity={WORKING}
        turnStartedAt={start}
        generationRate={{ tokensPerSecond: 84.4, measuredMs: 5_000 }}
        onOpenTasks={onOpenTasks}
      />,
    );
    // Viewer-native number formatting, never a hard-coded locale.
    const whole = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(84.4);

    await page.getByRole("button", { name: "Before activity" }).hover();
    await expectRevealed(false);
    const line = activityElement();
    const collapsedHeight = line.getBoundingClientRect().height;
    expect(line.getAttribute("aria-describedby")).toBeNull();

    await page.getByRole("button", { name: "Running command…. Show tasks" }).hover();
    await expectRevealed(true);
    expect(rateElement()?.textContent).toContain(`${whole} tok/s`);
    const describedBy = line.getAttribute("aria-describedby")?.split(" ") ?? [];
    expect(describedBy).toHaveLength(2);
    const rateDescription = document.getElementById(describedBy[1]!);
    expect(rateDescription?.textContent).toBe(`Generation speed: ${whole} tokens per second`);
    await expect
      .element(line)
      .toHaveAccessibleDescription(
        new RegExp(`^Elapsed turn time: .+ Generation speed: ${whole} tokens per second$`),
      );
    expect(Math.abs(line.getBoundingClientRect().height - collapsedHeight)).toBeLessThanOrEqual(1);

    // Slow rates keep one decimal; a missing measurement removes the segment.
    await mounted.rerender(
      <Fixture
        activity={WORKING}
        turnStartedAt={start}
        generationRate={{ tokensPerSecond: 7.25, measuredMs: 1_200 }}
        onOpenTasks={onOpenTasks}
      />,
    );
    const slow = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(7.25);
    expect(rateElement()?.textContent).toContain(`${slow} tok/s`);
    await mounted.rerender(
      <Fixture activity={WORKING} turnStartedAt={start} onOpenTasks={onOpenTasks} />,
    );
    expect(rateElement()).toBeNull();
    await expectElapsedDescription();
    expect(onOpenTasks).not.toHaveBeenCalled();
  });

  it("reveals on keyboard focus and preserves the existing Tasks action", async () => {
    const onOpenTasks = vi.fn();
    mounted = await render(
      <Fixture
        activity={WORKING}
        turnStartedAt={new Date().toISOString()}
        onOpenTasks={onOpenTasks}
      />,
    );
    const before = page.getByRole("button", { name: "Before activity" });
    await before.hover();
    before.element().focus();
    await userEvent.keyboard("{Tab}");
    const trigger = page.getByRole("button", { name: "Running command…. Show tasks" });
    expect(document.activeElement).toBe(trigger.element());
    await expectRevealed(true);
    await expectElapsedDescription();
    await userEvent.keyboard("{Enter}");
    expect(onOpenTasks).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(
      page.getByRole("button", { name: "After activity" }).element(),
    );
    await expectRevealed(false);
  });

  it("allows non-actionable attention text to reveal on focus without inventing an action", async () => {
    const onOpenTasks = vi.fn();
    mounted = await render(
      <Fixture
        activity={{
          ...WORKING,
          label: "Waiting for your answer",
          attention: true,
          canInspect: false,
        }}
        turnStartedAt={new Date(Date.now() - 20_000).toISOString()}
        onOpenTasks={onOpenTasks}
      />,
    );
    const before = page.getByRole("button", { name: "Before activity" });
    await before.hover();
    before.element().focus();
    await userEvent.keyboard("{Tab}");
    const line = activityElement();
    expect(line.tagName).toBe("DIV");
    expect(line.tabIndex).toBe(0);
    expect(document.activeElement).toBe(line);
    await expectRevealed(true);
    await expectElapsedDescription();
    await userEvent.keyboard("{Enter}");
    expect(onOpenTasks).not.toHaveBeenCalled();
    expect(line.querySelector("button")).toBeNull();
    await userEvent.keyboard("{Tab}");
    await expectRevealed(false);
  });

  it.each([true, false])(
    "clears detached keyboard focus when inspectability changes from %s",
    async (canInspect) => {
      const intervals = vi.spyOn(window, "setInterval");
      const clear = vi.spyOn(window, "clearInterval");
      const onOpenTasks = vi.fn();
      const start = new Date(Date.now() - 45_000).toISOString();
      mounted = await render(
        <Fixture
          activity={{ ...WORKING, canInspect }}
          turnStartedAt={start}
          onOpenTasks={onOpenTasks}
        />,
      );
      const before = page.getByRole("button", { name: "Before activity" });
      // Keep the native pointer outside both branches, so a replacement may
      // reveal only on its own new focus, never the detached node's state.
      await before.hover();
      before.element().focus();
      await userEvent.keyboard("{Tab}");
      const original = activityElement();
      expect(original.tagName).toBe(canInspect ? "BUTTON" : "DIV");
      expect(document.activeElement).toBe(original);
      await expectRevealed(true);
      await expectElapsedDescription();
      const intervalIndex = intervals.mock.calls.findIndex((call) => call[1] === 1000);
      expect(intervalIndex).toBeGreaterThanOrEqual(0);
      const interval = intervals.mock.results[intervalIndex];
      expect(interval?.type).toBe("return");

      await mounted.rerender(
        <Fixture
          activity={{ ...WORKING, canInspect: !canInspect }}
          turnStartedAt={start}
          onOpenTasks={onOpenTasks}
        />,
      );
      const replacement = activityElement();
      expect(replacement).not.toBe(original);
      expect(replacement.tagName).toBe(canInspect ? "DIV" : "BUTTON");
      expect(original.isConnected).toBe(false);
      expect(document.activeElement).not.toBe(replacement);
      await expectRevealed(false);
      expect(replacement.getAttribute("aria-describedby")).toBeNull();
      expect(clear).toHaveBeenCalledWith(interval!.value);
      expect(onOpenTasks).not.toHaveBeenCalled();

      before.element().focus();
      await userEvent.keyboard("{Tab}");
      expect(document.activeElement).toBe(replacement);
      await expectRevealed(true);
      await expectElapsedDescription();
      await userEvent.keyboard("{Enter}");
      expect(onOpenTasks).toHaveBeenCalledTimes(canInspect ? 0 : 1);
    },
  );

  it.each([true, false])(
    "immediately preserves elapsed time under a real pointer when inspectability changes from %s",
    async (canInspect) => {
      const onOpenTasks = vi.fn();
      const start = new Date(Date.now() - 91_000).toISOString();
      mounted = await render(
        <Fixture
          activity={{ ...WORKING, canInspect }}
          turnStartedAt={start}
          onOpenTasks={onOpenTasks}
        />,
      );
      const label = page.getByRole("status");
      // This stable left-of-label point lies inside both branches. Hover their
      // shared label rather than the differently sized outer button/div's
      // center, and do not move the native pointer during replacement.
      await label.hover({
        position: { x: 24, y: label.element().getBoundingClientRect().height / 2 },
      });
      await expectRevealed(true);
      const original = activityElement();
      const originalTimer = elapsedTimer();
      const firstElapsed = elapsedSeconds();
      expect(firstElapsed).toBeGreaterThanOrEqual(91);

      await mounted.rerender(
        <Fixture
          activity={{ ...WORKING, canInspect: !canInspect }}
          turnStartedAt={start}
          onOpenTasks={onOpenTasks}
        />,
      );
      expect(activityElement()).not.toBe(original);
      expect(originalTimer.isConnected).toBe(false);
      expect(elapsedTimer()).not.toBe(originalTimer);
      expect(elapsedWrapper().dataset.activityElapsedRevealed).toBe("true");
      // Deliberately assert immediately after the settled React commit. A
      // polling assertion could hide a fresh node stuck at 0s until next tick.
      expect(elapsedSeconds()).toBeGreaterThanOrEqual(firstElapsed);
      await expectElapsedDescription();
      expect(onOpenTasks).not.toHaveBeenCalled();
      await page.getByRole("button", { name: "After activity" }).hover();
      await expectRevealed(false);
    },
  );

  it("keeps the original turn edge across activity labels and resets for a new turn", async () => {
    const onOpenTasks = vi.fn();
    const start = new Date(Date.now() - 125_000).toISOString();
    mounted = await render(
      <Fixture activity={WORKING} turnStartedAt={start} onOpenTasks={onOpenTasks} />,
    );
    await page.getByRole("button", { name: "Running command…. Show tasks" }).hover();
    await expectRevealed(true);
    const timer = elapsedTimer();
    const firstElapsed = elapsedSeconds();
    expect(firstElapsed).toBeGreaterThanOrEqual(125);

    await mounted.rerender(
      <Fixture
        activity={{ ...WORKING, label: "Waiting for an agent…" }}
        turnStartedAt={start}
        onOpenTasks={onOpenTasks}
      />,
    );
    await expectRevealed(true);
    expect(elapsedTimer()).toBe(timer);
    expect(elapsedSeconds()).toBeGreaterThanOrEqual(firstElapsed);
    await expect.element(page.getByRole("status")).toHaveTextContent("Waiting for an agent…");
    // Wait for one real native interval tick. This does not advance time or
    // replace the existing test deadline; it proves the unchanged start edge
    // progresses after a label-only render instead of resetting the clock.
    await vi.waitFor(() => expect(elapsedSeconds()).toBeGreaterThan(firstElapsed), {
      timeout: 3_000,
    });

    const newStart = Date.now() - 3_000;
    await mounted.rerender(
      <Fixture
        activity={{ ...WORKING, label: "Working…" }}
        turnStartedAt={new Date(newStart).toISOString()}
        onOpenTasks={onOpenTasks}
      />,
    );
    await vi.waitFor(() => {
      const seconds = elapsedSeconds();
      expect(seconds).toBeGreaterThanOrEqual(3);
      expect(seconds).toBeLessThanOrEqual(Math.floor((Date.now() - newStart) / 1000));
      expect(seconds).toBeLessThan(firstElapsed);
    });
    expect(onOpenTasks).not.toHaveBeenCalled();
  });

  it.each([undefined, null, "", "not-a-timestamp"])(
    "omits timing and the extra focus stop for unavailable start %s",
    async (turnStartedAt) => {
      const onOpenTasks = vi.fn();
      mounted = await render(
        <Fixture
          activity={{ ...WORKING, canInspect: false }}
          turnStartedAt={turnStartedAt}
          onOpenTasks={onOpenTasks}
        />,
      );
      const before = page.getByRole("button", { name: "Before activity" });
      await before.hover();
      before.element().focus();
      await userEvent.keyboard("{Tab}");
      expect(document.activeElement).toBe(
        page.getByRole("button", { name: "After activity" }).element(),
      );
      expect(activityElement().tabIndex).toBe(-1);
      expect(document.querySelector('[role="timer"]')).toBeNull();
      expect(document.querySelector("[data-activity-elapsed-revealed]")).toBeNull();
      expect(onOpenTasks).not.toHaveBeenCalled();
    },
  );

  it("clamps a future start to zero without altering the activity or Tasks action", async () => {
    const onOpenTasks = vi.fn();
    mounted = await render(
      <Fixture
        activity={WORKING}
        turnStartedAt={new Date(Date.now() + 3_600_000).toISOString()}
        onOpenTasks={onOpenTasks}
      />,
    );
    await page.getByRole("button", { name: "Running command…. Show tasks" }).hover();
    await expectRevealed(true);
    expect(elapsedSeconds()).toBe(0);
    await expect.element(page.getByRole("status")).toHaveTextContent(WORKING.label);
    expect(onOpenTasks).not.toHaveBeenCalled();
  });

  it("owns no collapsed timer and retires revealed timers on leave, new turn, hide and unmount", async () => {
    // These spies call the native browser APIs. Only visibility is an isolated
    // fixture property; real time and every actual interval remain untouched.
    const intervals = vi.spyOn(window, "setInterval");
    const clear = vi.spyOn(window, "clearInterval");
    const addListener = vi.spyOn(document, "addEventListener");
    const removeListener = vi.spyOn(document, "removeEventListener");
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const issuedIntervals = () =>
      intervals.mock.calls.flatMap((call, index) => {
        const result = intervals.mock.results[index];
        return call[1] === 1000 && result?.type === "return" ? [result.value] : [];
      });
    const start = new Date(Date.now() - 30_000).toISOString();
    mounted = await render(
      <Fixture activity={WORKING} turnStartedAt={start} onOpenTasks={vi.fn()} />,
    );
    const before = page.getByRole("button", { name: "Before activity" });
    await before.hover();
    await expectRevealed(false);
    expect(issuedIntervals()).toHaveLength(0);

    await page.getByRole("button", { name: "Running command…. Show tasks" }).hover();
    await expectRevealed(true);
    expect(issuedIntervals()).toHaveLength(1);
    const hoverInterval = issuedIntervals()[0];
    await before.hover();
    await expectRevealed(false);
    expect(clear).toHaveBeenCalledWith(hoverInterval);
    before.element().focus();
    await userEvent.keyboard("{Tab}");
    await expectRevealed(true);
    expect(issuedIntervals()).toHaveLength(2);
    const focusInterval = issuedIntervals()[1];

    await mounted.rerender(
      <Fixture
        activity={WORKING}
        turnStartedAt={new Date(Date.now()).toISOString()}
        onOpenTasks={vi.fn()}
      />,
    );
    expect(clear).toHaveBeenCalledWith(focusInterval);
    expect(issuedIntervals()).toHaveLength(3);
    const newTurnInterval = issuedIntervals()[2];
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(clear).toHaveBeenCalledWith(newTurnInterval);
    expect(issuedIntervals()).toHaveLength(3);

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(issuedIntervals()).toHaveLength(4);
    const restoredInterval = issuedIntervals()[3];
    const visibilityListener = addListener.mock.calls.findLast(
      ([name]) => name === "visibilitychange",
    )?.[1];
    expect(visibilityListener).toBeDefined();
    await mounted.unmount();
    mounted = undefined;
    expect(clear).toHaveBeenCalledWith(restoredInterval);
    expect(removeListener).toHaveBeenCalledWith("visibilitychange", visibilityListener);
    expect(issuedIntervals()).toHaveLength(4);
  });

  it.each(
    (["light", "dark"] as const).flatMap((theme) => [80, 130].map((scale) => ({ theme, scale }))),
  )(
    "keeps long elapsed time and Tasks usable at narrow $theme/$scale% with reduced motion at130%",
    async ({ theme, scale }) => {
      await page.viewport(360, 640);
      document.documentElement.classList.toggle("dark", theme === "dark");
      applyInterfaceScalePercent(scale);
      const reducedMotion = scale === 130;
      await cdp().send("Emulation.setEmulatedMedia", {
        features: [
          { name: "prefers-reduced-motion", value: reducedMotion ? "reduce" : "no-preference" },
        ],
      });
      const onOpenTasks = vi.fn();
      mounted = await render(
        <Fixture
          width={320}
          activity={{ ...WORKING, label: "Running a long workspace verification command…" }}
          turnStartedAt={new Date(Date.now() - (124 * 3600 + 59 * 60 + 43) * 1000).toISOString()}
          onOpenTasks={onOpenTasks}
        />,
      );
      await page.getByRole("button", { name: "Before activity" }).hover();
      await expectRevealed(false);
      const height = activityElement().getBoundingClientRect().height;
      const trigger = page.getByRole("button", {
        name: "Running a long workspace verification command…. Show tasks",
      });
      await trigger.hover();
      await expectRevealed(true);
      const line = activityElement();
      const bounds = line.getBoundingClientRect();
      const timerBounds = elapsedTimer().getBoundingClientRect();
      expect(elapsedSeconds()).toBeGreaterThanOrEqual(124 * 3600);
      expect(Math.abs(bounds.height - height)).toBeLessThanOrEqual(1);
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);
      expect(timerBounds.right).toBeLessThanOrEqual(bounds.right + 1);
      expect(line.scrollWidth).toBeLessThanOrEqual(line.clientWidth + 1);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
      expect(elapsedTimer().getAttribute("aria-live")).toBe("off");
      if (reducedMotion) {
        // Tailwind's transition-none disables the property, not the retained
        // duration token. Assert the actual absence of motion for both the
        // reveal container and the existing status spinner.
        expect(getComputedStyle(elapsedWrapper()).transitionProperty).toBe("none");
        const spinner = line.querySelector<SVGElement>('[data-slot="spinner"]');
        expect(spinner).not.toBeNull();
        expect(getComputedStyle(spinner!).animationName).toBe("none");
      }
      await trigger.click();
      expect(onOpenTasks).toHaveBeenCalledTimes(1);
      // Opt-in local evidence is separate from every assertion and native CI.
      // Output stays inside Vite's existing filesystem allowance; a caller may
      // copy these inert artifacts elsewhere without broadening that boundary.
      const evidenceDirectory = import.meta.env.VITE_CAFE_ACTIVITY_HOVER_EVIDENCE_DIR;
      if (typeof evidenceDirectory === "string" && evidenceDirectory.length > 0) {
        await page.screenshot({
          path: `${evidenceDirectory}/activity-hover-${theme}-${scale}.png`,
        });
      }
    },
  );
});
