import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import "../../index.css";
import { ScrollToBottomControl } from "./ScrollToBottomControl";
it("supports keyboard disclosure, cancellation and scrolling under reduced motion", async () => {
  expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
  const scroll = vi.fn(),
    hide = vi.fn();
  const mounted = await render(
    <>
      <button type="button">Before scroll controls</button>
      <ScrollToBottomControl onScrollToBottom={scroll} onHideUntilBottom={hide} />
    </>,
  );
  try {
    await page.getByRole("button", { name: "Before scroll controls", exact: true }).click();
    await userEvent.tab();
    const primary = page.getByRole("button", { name: "Scroll to bottom", exact: true });
    await expect.element(primary).toHaveFocus();
    await expect
      .element(page.getByRole("button", { name: "Hide until bottom", exact: true }))
      .toBeVisible();
    expect(scroll).not.toHaveBeenCalled();
    expect(hide).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    await expect
      .element(page.getByRole("button", { name: "Hide until bottom", exact: true }))
      .not.toBeInTheDocument();
    await expect.element(primary).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(scroll).toHaveBeenCalledOnce();
    expect(hide).not.toHaveBeenCalled();
  } finally {
    await mounted.unmount();
  }
});
