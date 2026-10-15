import "../../index.css";

import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { ScrollToBottomControl } from "./ScrollToBottomControl";

let mounted: Awaited<ReturnType<typeof render>> | undefined;
const originalFontSize = document.documentElement.style.fontSize;
const originalFontPriority = document.documentElement.style.getPropertyPriority("font-size");
const originalDark = document.documentElement.classList.contains("dark");
const originalViewport = { width: window.innerWidth, height: window.innerHeight };

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  document.documentElement.style.setProperty("font-size", originalFontSize, originalFontPriority);
  document.documentElement.classList.toggle("dark", originalDark);
  await page.viewport(originalViewport.width, originalViewport.height);
});

/** This complete file belongs to the existing provider-owned reduced-motion
 * context. Observe native media and actual Base UI lifecycle attributes rather
 * than forcing starting/ending CSS or changing a reused desktop page's media. */
it.each([false, true].flatMap((dark) => [80, 130].map((scale) => ({ dark, scale }))))(
  "retains anchored keyboard disclosure without travel or scaling under native reduced motion (dark=$dark scale=$scale)",
  async ({ dark, scale }) => {
    expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
    expect(window.matchMedia("(hover: hover)").matches).toBe(true);
    expect(window.matchMedia("(pointer: fine)").matches).toBe(true);
    await page.viewport(430, 680);
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.style.fontSize = `${scale}%`;
    const scroll = vi.fn();
    const hide = vi.fn();
    const observed: Array<{ stage: "starting" | "ending"; scale: string; translate: string }> = [];
    const observePopup = () => {
      const popup = document.querySelector<HTMLElement>("[data-scroll-to-bottom-popup]");
      if (!popup || observed.length >= 16) return;
      const stage = popup.hasAttribute("data-starting-style")
        ? "starting"
        : popup.hasAttribute("data-ending-style")
          ? "ending"
          : null;
      if (stage === null) return;
      const style = getComputedStyle(popup);
      observed.push({ stage, scale: style.scale, translate: style.translate });
    };
    const observer = new MutationObserver(observePopup);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-starting-style", "data-ending-style"],
    });
    try {
      mounted = await render(
        <>
          <button type="button">Before scroll controls</button>
          <div
            className="bg-background text-foreground"
            style={{
              position: "fixed",
              left: 16,
              bottom: 24,
              width: 320,
              maxWidth: "calc(100% - 32px)",
              display: "flex",
              justifyContent: "center",
            }}
          >
            <ScrollToBottomControl onScrollToBottom={scroll} onHideUntilBottom={hide} />
          </div>
        </>,
      );
      const primary = page.getByRole("button", { name: "Scroll to bottom", exact: true });
      const pill = document.querySelector<HTMLElement>("[data-scroll-to-bottom-control]")!;
      const originalRect = pill.getBoundingClientRect();
      expect(document.querySelector("[data-scroll-to-bottom-popup]")).toBeNull();

      // Native Tab focuses the unchanged main action; inspection itself must
      // not submit that scroll action or hide anything from the timeline.
      await page.getByRole("button", { name: "Before scroll controls", exact: true }).click();
      await userEvent.keyboard("{Tab}");
      await expect.element(primary).toHaveFocus();
      const hideAction = page.getByRole("button", { name: "Hide until bottom", exact: true });
      await expect.element(hideAction).toBeVisible();
      await expect.poll(() => observed.some((sample) => sample.stage === "starting")).toBe(true);
      const popup = document.querySelector<HTMLElement>("[data-scroll-to-bottom-popup]")!;
      // Observe the completed native entrance before qualifying its exit. An
      // immediate close from opacity zero has no real fade to retire and would
      // not establish that the ordinary ending edge removed movement.
      await expect
        .poll(
          () =>
            !popup.hasAttribute("data-starting-style") && getComputedStyle(popup).opacity === "1",
        )
        .toBe(true);
      const popupRect = popup.getBoundingClientRect();
      expect(popupRect.width).toBeGreaterThan(0);
      expect(popupRect.height).toBeGreaterThan(0);
      expect(popupRect.left).toBeGreaterThanOrEqual(0);
      expect(popupRect.right).toBeLessThanOrEqual(window.innerWidth);
      expect(popupRect.top).toBeGreaterThanOrEqual(0);
      expect(popupRect.bottom).toBeLessThanOrEqual(originalRect.top + 1);
      expect(popup.scrollWidth).toBeLessThanOrEqual(popup.clientWidth + 1);
      expect(
        Math.abs(pill.getBoundingClientRect().height - originalRect.height),
      ).toBeLessThanOrEqual(1);
      expect(Math.abs(pill.getBoundingClientRect().top - originalRect.top)).toBeLessThanOrEqual(1);
      expect(scroll).not.toHaveBeenCalled();
      expect(hide).not.toHaveBeenCalled();

      await userEvent.keyboard("{Escape}");
      await expect.poll(() => observed.some((sample) => sample.stage === "ending")).toBe(true);
      await expect.poll(() => document.querySelector("[data-scroll-to-bottom-popup]")).toBeNull();
      await expect.element(primary).toHaveFocus();
      expect(observed.length).toBeGreaterThanOrEqual(2);
      for (const sample of observed) {
        // Reduced motion preserves the shared opacity fade but removes actual
        // scale/travel at both lifecycle edges, not merely in settled output.
        expect(sample.scale).toBe("1");
        expect(sample.translate).toBe("none");
      }

      await userEvent.keyboard("{Enter}");
      expect(scroll).toHaveBeenCalledOnce();
      expect(hide).not.toHaveBeenCalled();
      expect(document.querySelector("[data-scroll-to-bottom-popup]")).toBeNull();
    } finally {
      observer.disconnect();
    }
  },
);
