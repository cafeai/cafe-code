import "../../index.css";

import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { InfoTip } from "./info-tip";
import { SegmentedControl, type SegmentedControlOption } from "./segmented-control";

type Range = "day" | "week" | "month";

const OPTIONS: ReadonlyArray<SegmentedControlOption<Range>> = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
];

function ControlledFixture({
  onValueChange,
  options = OPTIONS,
}: {
  onValueChange: (value: Range) => void;
  options?: ReadonlyArray<SegmentedControlOption<Range>>;
}) {
  const [value, setValue] = useState<Range>("day");
  return (
    <SegmentedControl
      aria-label="Range"
      options={options}
      value={value}
      onValueChange={(next) => {
        onValueChange(next);
        setValue(next);
      }}
    />
  );
}

function indicator(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-slot="segmented-control-indicator"]');
  if (!element) throw new Error("Segmented control indicator is not rendered");
  return element;
}

function segment(name: string): HTMLElement {
  return page.getByRole("button", { name, exact: true }).element() as HTMLElement;
}

// The indicator is placed with an inline `translate`, so its resting position
// is the selected segment's offset within the track.
function indicatorRestsOn(name: string): boolean {
  const target = segment(name);
  const style = indicator().style;
  return (
    (style.translate === `${target.offsetLeft}px 0px` ||
      style.translate === `${target.offsetLeft}px`) &&
    style.width === `${target.offsetWidth}px`
  );
}

describe("SegmentedControl", () => {
  it("marks the selected option and slides the indicator when the selection changes", async () => {
    const onValueChange = vi.fn();
    await render(<ControlledFixture onValueChange={onValueChange} />);

    await expect.element(page.getByRole("group", { name: "Range" })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Day", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    await expect
      .element(page.getByRole("button", { name: "Week", exact: true }))
      .toHaveAttribute("aria-pressed", "false");
    await expect.poll(() => indicatorRestsOn("Day")).toBe(true);

    await page.getByRole("button", { name: "Month", exact: true }).click();

    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenLastCalledWith("month");
    await expect
      .element(page.getByRole("button", { name: "Month", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    await expect
      .element(page.getByRole("button", { name: "Day", exact: true }))
      .toHaveAttribute("aria-pressed", "false");
    // Movement uses transform-family properties only, never left/top.
    expect(getComputedStyle(indicator()).transitionProperty).toContain("translate");
    await expect.poll(() => indicatorRestsOn("Month")).toBe(true);
  });

  it("keeps exactly one selection when the pressed option is clicked again", async () => {
    const onValueChange = vi.fn();
    await render(<ControlledFixture onValueChange={onValueChange} />);

    await page.getByRole("button", { name: "Day", exact: true }).click();

    expect(onValueChange).not.toHaveBeenCalled();
    await expect
      .element(page.getByRole("button", { name: "Day", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
  });

  it("supports arrow-key focus movement and keyboard selection", async () => {
    const onValueChange = vi.fn();
    await render(
      <div>
        <button type="button">Before</button>
        <ControlledFixture onValueChange={onValueChange} />
      </div>,
    );

    await page.getByRole("button", { name: "Before" }).click();
    await userEvent.tab();
    await expect.element(page.getByRole("button", { name: "Day", exact: true })).toHaveFocus();

    await userEvent.keyboard("{ArrowRight}");
    await expect.element(page.getByRole("button", { name: "Week", exact: true })).toHaveFocus();
    // Moving focus alone does not change the selection.
    expect(onValueChange).not.toHaveBeenCalled();

    await userEvent.keyboard("{Enter}");
    expect(onValueChange).toHaveBeenLastCalledWith("week");
    await expect
      .element(page.getByRole("button", { name: "Week", exact: true }))
      .toHaveAttribute("aria-pressed", "true");

    await userEvent.keyboard("{ArrowRight} ");
    expect(onValueChange).toHaveBeenLastCalledWith("month");
    await expect.poll(() => indicatorRestsOn("Month")).toBe(true);
  });

  it("does not select a disabled option", async () => {
    const onValueChange = vi.fn();
    await render(
      <ControlledFixture
        onValueChange={onValueChange}
        options={[
          { value: "day", label: "Day" },
          { value: "week", label: "Week", disabled: true },
          { value: "month", label: "Month" },
        ]}
      />,
    );

    await expect.element(page.getByRole("button", { name: "Week", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Week", exact: true }).click({ force: true });
    expect(onValueChange).not.toHaveBeenCalled();
    await expect
      .element(page.getByRole("button", { name: "Day", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
  });
});

describe("InfoTip", () => {
  it("has an accessible name and opens on keyboard focus with the text as its description", async () => {
    await render(
      <div>
        <button type="button">Before</button>
        <InfoTip label="About cached input">Cached input counts toward processed tokens.</InfoTip>
      </div>,
    );

    const trigger = page.getByRole("button", { name: "About cached input" });
    await expect.element(trigger).toBeVisible();
    // Closed tips render no popup text.
    expect(document.querySelector('[data-slot="tooltip-popup"]')).toBeNull();

    await page.getByRole("button", { name: "Before" }).click();
    await userEvent.tab();
    await expect.element(trigger).toHaveFocus();

    await expect
      .element(page.getByText("Cached input counts toward processed tokens."))
      .toBeVisible();
    await expect
      .element(trigger)
      .toHaveAccessibleDescription("Cached input counts toward processed tokens.");

    await userEvent.keyboard("{Escape}");
    await expect
      .element(page.getByText("Cached input counts toward processed tokens."))
      .not.toBeInTheDocument();
  });

  it("opens on click so pointer and touch users can pin it", async () => {
    await render(<InfoTip label="About limits">Limits reset every five hours.</InfoTip>);

    await page.getByRole("button", { name: "About limits" }).click();
    await expect.element(page.getByText("Limits reset every five hours.")).toBeVisible();
  });
});
