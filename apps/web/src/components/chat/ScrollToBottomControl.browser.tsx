import "../../index.css";

import { getUiLocale, setUiLocale, uiText, type UiLocale } from "@cafecode/shared/i18n";
import { expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { Button } from "../ui/button";
import { ScrollToBottomControl } from "./ScrollToBottomControl";

const popup = () => document.querySelector<HTMLDivElement>('[data-scroll-to-bottom-popup="true"]');
const primary = () =>
  document.querySelector<HTMLButtonElement>('[data-scroll-to-bottom-primary="true"]');
const options = () =>
  document.querySelector<HTMLButtonElement>('[data-scroll-to-bottom-options="true"]');

async function mountControl() {
  const onScrollToBottom = vi.fn();
  const onHideUntilBottom = vi.fn();
  const view = await render(
    <div className="bg-background text-foreground">
      <Button data-scroll-control-before="true">Before control</Button>
      <div className="fixed bottom-2 left-1/2 flex -translate-x-1/2 justify-center">
        <ScrollToBottomControl
          onScrollToBottom={onScrollToBottom}
          onHideUntilBottom={onHideUntilBottom}
        />
      </div>
      <Button data-scroll-control-after="true">After control</Button>
    </div>,
  );
  return { view, onScrollToBottom, onHideUntilBottom };
}

/** Observe the primitive's actual finite entrance before strict geometry; no
 * input/motion emulation, arbitrary delay or manual target focus is needed. */
async function settleEntrance(element: HTMLElement) {
  await Promise.all(
    element
      .getAnimations({ subtree: true })
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
      .map((animation) => animation.finished),
  );
}

it.each([
  ["light", 80],
  ["light", 130],
  ["dark", 80],
  ["dark", 130],
] as const)(
  "reveals the hide action on native hover without stealing focus in narrow %s at %i%%",
  async (theme, scale) => {
    expect(matchMedia("(hover: hover)").matches).toBe(true);
    expect(matchMedia("(pointer: fine)").matches).toBe(true);
    const root = document.documentElement;
    const previousClass = root.className;
    const previousFont = root.style.getPropertyValue("font-size");
    const previousFontPriority = root.style.getPropertyPriority("font-size");
    const previousLocale = getUiLocale();
    const previousViewport = { width: innerWidth, height: innerHeight };
    setUiLocale("en");
    root.classList.toggle("dark", theme === "dark");
    root.style.setProperty("font-size", `${scale}%`);
    await page.viewport(430, 520);
    const { view, onScrollToBottom, onHideUntilBottom } = await mountControl();
    try {
      const before = page.getByRole("button", { name: "Before control", exact: true });
      const scroll = page.getByRole("button", { name: "Scroll to bottom", exact: true });
      await before.click();
      await expect.element(before).toHaveFocus();
      // A retained native pointer can initially hover a newly mounted pill.
      // The outside press dismisses that real preview, but its finite exit
      // precedes unmount. Also finish the pill's actual rise before recording
      // exact transformed DOMRect geometry; neither observation changes input.
      await vi.waitFor(() => expect(popup()).toBeNull());
      const pill = document.querySelector<HTMLElement>("[data-scroll-to-bottom-control]")!;
      await settleEntrance(pill);
      const initialPill = pill.getBoundingClientRect();
      await scroll.hover();
      const hide = page.getByRole("button", { name: "Hide until bottom", exact: true });
      await expect.element(hide).toBeVisible();
      await expect.element(before).toHaveFocus();
      const currentPopup = popup()!;
      await settleEntrance(currentPopup);
      const rect = currentPopup.getBoundingClientRect();
      expect(rect.width).toBeGreaterThan(0);
      expect(rect.height).toBeGreaterThan(0);
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.right).toBeLessThanOrEqual(innerWidth);
      expect(rect.top).toBeGreaterThanOrEqual(0);
      expect(rect.bottom).toBeLessThanOrEqual(initialPill.top);
      expect(currentPopup.scrollWidth).toBeLessThanOrEqual(currentPopup.clientWidth);
      expect(getComputedStyle(currentPopup).backgroundColor).toBe(
        getComputedStyle(primary()!.parentElement!).backgroundColor,
      );
      const revealedPill = primary()!.parentElement!.getBoundingClientRect();
      expect(revealedPill.height).toBe(initialPill.height);
      expect(revealedPill.width).toBe(initialPill.width);
      expect(primary()).toBe(scroll.element());
      expect(primary()!.querySelector("button")).toBeNull();
      expect(options()!.querySelector("button")).toBeNull();

      // The native safe-hover corridor connects the pill to its portal. Moving
      // into and clicking the real action must not activate the scroll button.
      await hide.hover();
      await expect.element(hide).toBeVisible();
      await hide.click();
      expect(onHideUntilBottom).toHaveBeenCalledOnce();
      expect(onScrollToBottom).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(popup()).toBeNull());
    } finally {
      await view.unmount();
      root.className = previousClass;
      if (previousFont) root.style.setProperty("font-size", previousFont, previousFontPriority);
      else root.style.removeProperty("font-size");
      setUiLocale(previousLocale);
      await page.viewport(previousViewport.width, previousViewport.height);
    }
  },
);

it("keeps the main native press a scroll action and dismisses an unpinned hover preview on exit", async () => {
  const previousLocale = getUiLocale();
  setUiLocale("en");
  const { view, onScrollToBottom, onHideUntilBottom } = await mountControl();
  try {
    const before = page.getByRole("button", { name: "Before control", exact: true });
    const scroll = page.getByRole("button", { name: "Scroll to bottom", exact: true });
    await before.click();
    await scroll.hover();
    await expect
      .element(page.getByRole("button", { name: "Hide until bottom", exact: true }))
      .toBeVisible();
    await before.hover();
    await vi.waitFor(() => expect(popup()).toBeNull());
    expect(onScrollToBottom).not.toHaveBeenCalled();
    expect(onHideUntilBottom).not.toHaveBeenCalled();
    await scroll.click();
    expect(onScrollToBottom).toHaveBeenCalledOnce();
    expect(onHideUntilBottom).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(popup()).toBeNull());
    await expect.element(scroll).toHaveFocus();
  } finally {
    await view.unmount();
    setUiLocale(previousLocale);
  }
});

it("exposes the action on keyboard focus, preserves the ring and keeps Escape dismissed on restored focus", async () => {
  const previousLocale = getUiLocale();
  setUiLocale("en");
  const { view, onScrollToBottom, onHideUntilBottom } = await mountControl();
  try {
    const before = page.getByRole("button", { name: "Before control", exact: true });
    const scroll = page.getByRole("button", { name: "Scroll to bottom", exact: true });
    const hide = page.getByRole("button", { name: "Hide until bottom", exact: true });
    await before.click();
    // Native pointer ownership can reveal the newly mounted pill before this
    // outside press. Base UI retains its focus guards throughout the actual
    // exit: begin the one Tab only after that popup has unmounted and the exact
    // outside button owns focus, not merely after the click RPC completed.
    await vi.waitFor(() => expect(popup()).toBeNull());
    await expect.element(before).toHaveFocus();
    await userEvent.keyboard("{Tab}");
    await expect.element(scroll).toHaveFocus();
    await expect.element(hide).toBeVisible();
    expect(primary()!.matches(":focus-visible")).toBe(true);
    expect(getComputedStyle(primary()!).boxShadow).not.toBe("none");
    // Base UI's nonmodal focus guards transfer Tab to the actual popup. Observe
    // that queued focus before activating; visibility alone is not readiness.
    await userEvent.keyboard("{Tab}");
    await expect.element(hide).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect.element(scroll).toHaveFocus();
    await vi.waitFor(() => expect(popup()).toBeNull());
    expect(onScrollToBottom).not.toHaveBeenCalled();
    expect(onHideUntilBottom).not.toHaveBeenCalled();

    await userEvent.keyboard("{Tab}");
    const disclosure = page.getByRole("button", {
      name: "Scroll to bottom options",
      exact: true,
    });
    await expect.element(disclosure).toHaveFocus();
    await expect.element(hide).toBeVisible();
    await userEvent.keyboard("{Tab}");
    await expect.element(hide).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(onHideUntilBottom).toHaveBeenCalledOnce();
    expect(onScrollToBottom).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(popup()).toBeNull());
    await expect.element(disclosure).toHaveFocus();
  } finally {
    await view.unmount();
    setUiLocale(previousLocale);
  }
});

it("pins an explicit options press until outside dismissal without consuming the outside action", async () => {
  const previousLocale = getUiLocale();
  setUiLocale("en");
  const { view, onScrollToBottom, onHideUntilBottom } = await mountControl();
  try {
    const disclosure = page.getByRole("button", {
      name: "Scroll to bottom options",
      exact: true,
    });
    const before = page.getByRole("button", { name: "Before control", exact: true });
    await disclosure.click();
    await expect
      .element(page.getByRole("button", { name: "Hide until bottom", exact: true }))
      .toBeVisible();
    await before.hover();
    expect(disclosure.element().getAttribute("aria-expanded")).toBe("true");
    await expect
      .element(page.getByRole("button", { name: "Hide until bottom", exact: true }))
      .toBeVisible();
    await before.click();
    await expect.element(before).toHaveFocus();
    await vi.waitFor(() => expect(popup()).toBeNull());
    expect(onScrollToBottom).not.toHaveBeenCalled();
    expect(onHideUntilBottom).not.toHaveBeenCalled();
  } finally {
    await view.unmount();
    setUiLocale(previousLocale);
  }
});

it("retranslates the retained control and open action without dispatching or replacing native buttons", async () => {
  const previousLocale = getUiLocale();
  setUiLocale("en");
  const { view, onScrollToBottom, onHideUntilBottom } = await mountControl();
  try {
    const originalPrimary = primary()!;
    const originalOptions = options()!;
    await page.getByRole("button", { name: "Scroll to bottom options", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "Hide until bottom", exact: true }))
      .toBeVisible();
    const originalPopup = popup()!;
    for (const locale of ["ja", "ko", "en"] as const satisfies readonly UiLocale[]) {
      setUiLocale(locale);
      await expect
        .element(
          page.getByRole("button", {
            name: uiText("Scroll to bottom", undefined, undefined, locale),
            exact: true,
          }),
        )
        .toBeVisible();
      await expect
        .element(
          page.getByRole("button", {
            name: uiText("Hide until bottom", undefined, undefined, locale),
            exact: true,
          }),
        )
        .toBeVisible();
      expect(originalOptions.getAttribute("aria-label")).toBe(
        uiText("Scroll to bottom options", undefined, undefined, locale),
      );
      expect(primary()).toBe(originalPrimary);
      expect(options()).toBe(originalOptions);
      expect(popup()).toBe(originalPopup);
    }
    expect(onScrollToBottom).not.toHaveBeenCalled();
    expect(onHideUntilBottom).not.toHaveBeenCalled();
  } finally {
    await view.unmount();
    setUiLocale(previousLocale);
  }
});
