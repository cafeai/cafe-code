import "../index.css";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { showContextMenuFallback } from "../contextMenuFallback";
import { applyInterfaceScalePercent } from "../interfaceScale";

afterEach(async () => {
  await userEvent.keyboard("{Escape}");
  document.documentElement.classList.remove("dark");
  applyInterfaceScalePercent(100);
});

function ContextMenuPaneFixture() {
  const [active, setActive] = useState("first");
  return (
    <div>
      <p role="status">Active pane: {active}</p>
      <section
        onPointerDownCapture={() => setActive("first")}
        onFocusCapture={() => setActive("first")}
      >
        <input aria-label="First composer" />
      </section>
      <section
        onPointerDownCapture={() => setActive("second")}
        onFocusCapture={() => setActive("second")}
      >
        <p>Second pane transcript</p>
      </section>
    </div>
  );
}

// These real-browser cases replace the former fake-DOM tests: focus, menu
// collision layout, SVG escaping and portal dismissal need the actual browser.
describe("shared context menu", () => {
  it("selects one exact leaf, restores focus and renders inert icon labels", async () => {
    const screen = await render(<button type="button">Open menu</button>);
    await screen.getByRole("button", { name: "Open menu" }).click();
    const promise = showContextMenuFallback(
      [
        { id: "rename", label: "Rename <script> chat" },
        { id: "delete", label: "Delete permanently…", destructive: true },
      ],
      { x: 30, y: 30 },
    );
    const row = page.getByRole("menuitem", { name: "Rename <script> chat" });
    await expect.element(row).toBeVisible();
    expect(row.element().querySelector("svg")).not.toBeNull();
    expect(row.element().querySelector("script")).toBeNull();
    await row.click();
    await expect(promise).resolves.toBe("rename");
    await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Open menu" }).element(),
    );
  });

  it("supports keyboard selection, disabled rows and Escape dismissal", async () => {
    const promise = showContextMenuFallback([
      { id: "rename", label: "Rename" },
      { id: "archive", label: "Archive", disabled: true },
      { id: "delete", label: "Move to Recycle Bin", destructive: true },
    ]);
    await expect.element(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
    await expect
      .poll(() => page.getByRole("menu").element().contains(document.activeElement))
      .toBe(true);
    await userEvent.keyboard("{Home}{ArrowDown}");
    // Base UI deliberately keeps disabled actions keyboard-discoverable.
    await expect
      .element(page.getByRole("menuitem", { name: "Archive", exact: true }))
      .toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByRole("menu")).toBeVisible();
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(page.getByRole("menuitem", { name: "Move to Recycle Bin" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect(promise).resolves.toBe("delete");
    const dismissed = showContextMenuFallback([{ id: "rename", label: "Rename" }]);
    await expect.element(page.getByRole("menu")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect(dismissed).resolves.toBeNull();
  });

  it("ignores the opening synthesized click without a new primary press", async () => {
    const promise = showContextMenuFallback([
      { id: "delete", label: "Delete permanently…", destructive: true },
    ]);
    const action = page.getByRole("menuitem", { name: "Delete permanently…" });
    await expect.element(action).toBeVisible();
    action
      .element()
      .dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 }),
      );
    await expect.element(action).toBeVisible();
    await action.click();
    await expect(promise).resolves.toBe("delete");
  });

  it("opens nested submenus with the keyboard and returns the exact leaf", async () => {
    const promise = showContextMenuFallback([
      {
        id: "move",
        label: "Move chat",
        children: [
          { id: "move:first", label: "First project" },
          { id: "move:second", label: "Second project" },
        ],
      },
    ]);
    const parent = page.getByRole("menuitem", { name: "Move chat" });
    await expect.element(parent).toBeVisible();
    await expect
      .poll(() => page.getByRole("menu").element().contains(document.activeElement))
      .toBe(true);
    await userEvent.keyboard("{Home}{ArrowRight}");
    await expect.element(page.getByRole("menuitem", { name: "Second project" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Second project" }).click();
    await expect(promise).resolves.toBe("move:second");
  });

  it("cancels an older menu when a new one opens and dismisses on outside click", async () => {
    const screen = await render(<button type="button">Outside</button>);
    const previous = showContextMenuFallback([{ id: "old", label: "Old action" }]);
    await expect.element(page.getByRole("menuitem", { name: "Old action" })).toBeVisible();
    const current = showContextMenuFallback([{ id: "new", label: "New action" }], {
      x: 300,
      y: 200,
    });
    await expect(previous).resolves.toBeNull();
    await expect.element(page.getByRole("menuitem", { name: "New action" })).toBeVisible();
    await screen.getByRole("button", { name: "Outside" }).click();
    await expect(current).resolves.toBeNull();
  });

  it.each(["pointer", "programmatic"] as const)(
    "preserves %s outside input focus without briefly refocusing the original composer",
    async (transfer) => {
      const firstFocus = vi.fn();
      const secondFocus = vi.fn();
      const screen = await render(
        <div>
          <input aria-label="First composer" onFocus={firstFocus} />
          <input aria-label="Second composer" onFocus={secondFocus} />
        </div>,
      );
      await screen.getByRole("textbox", { name: "First composer" }).click();
      const pending = showContextMenuFallback([{ id: "rename", label: "Rename" }], {
        x: 300,
        y: 200,
      });
      await expect
        .poll(() => page.getByRole("menu").element().contains(document.activeElement))
        .toBe(true);
      const second = screen.getByRole("textbox", { name: "Second composer" });
      if (transfer === "pointer") {
        await second.click();
      } else {
        // Focus may leave through keyboard navigation or another UI control,
        // without the pointer event that normally dismisses the menu first.
        // Escape must not steal that new focus even if the menu is still open.
        second.element().focus();
        await userEvent.keyboard("{Escape}");
      }
      await expect(pending).resolves.toBeNull();
      await expect.element(second).toHaveFocus();
      // A transient return to the first composer can activate its pane even if
      // the browser subsequently focuses the actual pointer target again.
      expect(firstFocus).toHaveBeenCalledTimes(1);
      expect(secondFocus).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves an outside pane activation when its transcript is not focusable", async () => {
    const screen = await render(<ContextMenuPaneFixture />);
    await screen.getByRole("textbox", { name: "First composer" }).click();
    const pending = showContextMenuFallback([{ id: "rename", label: "Rename" }], {
      x: 300,
      y: 200,
    });
    await expect
      .poll(() => page.getByRole("menu").element().contains(document.activeElement))
      .toBe(true);
    await screen.getByText("Second pane transcript", { exact: true }).click();
    await expect(pending).resolves.toBeNull();
    await expect.element(screen.getByRole("status")).toHaveTextContent("Active pane: second");
    await expect.element(screen.getByRole("textbox", { name: "First composer" })).not.toHaveFocus();
  });

  it.each(["escape", "selection"] as const)(
    "restores the original opener after replacement menu %s without a focus flash",
    async (close) => {
      const openerFocus = vi.fn();
      const screen = await render(
        <button type="button" onFocus={openerFocus}>
          Original opener
        </button>,
      );
      const opener = screen.getByRole("button", { name: "Original opener" });
      await opener.click();
      const previous = showContextMenuFallback([{ id: "old", label: "Old action" }]);
      await expect
        .poll(() => page.getByRole("menu").element().contains(document.activeElement))
        .toBe(true);
      const current = showContextMenuFallback([{ id: "new", label: "New action" }]);
      await expect(previous).resolves.toBeNull();
      await expect.element(page.getByRole("menuitem", { name: "New action" })).toBeVisible();
      await expect
        .poll(() => page.getByRole("menu").element().contains(document.activeElement))
        .toBe(true);
      expect(openerFocus).toHaveBeenCalledTimes(1);
      await userEvent.keyboard(close === "escape" ? "{Escape}" : "{Home}{Enter}");
      await expect(current).resolves.toBe(close === "escape" ? null : "new");
      await expect.element(opener).toHaveFocus();
      expect(openerFocus).toHaveBeenCalledTimes(2);
    },
  );

  it("retains the opener across rapid replacements of a focused portalled submenu", async () => {
    const openerFocus = vi.fn();
    const screen = await render(
      <button type="button" onFocus={openerFocus}>
        Original opener
      </button>,
    );
    const opener = screen.getByRole("button", { name: "Original opener" });
    await opener.click();
    const previous = showContextMenuFallback([
      {
        id: "move",
        label: "Move chat",
        children: [{ id: "move:first", label: "First project" }],
      },
    ]);
    await expect
      .poll(() => page.getByRole("menu").element().contains(document.activeElement))
      .toBe(true);
    await userEvent.keyboard("{Home}{ArrowRight}");
    await expect.element(page.getByRole("menuitem", { name: "First project" })).toHaveFocus();
    const intermediate = showContextMenuFallback([{ id: "middle", label: "Middle action" }]);
    const current = showContextMenuFallback([{ id: "new", label: "New action" }]);
    await expect(previous).resolves.toBeNull();
    await expect(intermediate).resolves.toBeNull();
    await expect.element(page.getByRole("menuitem", { name: "New action" })).toBeVisible();
    await expect
      .poll(() => page.getByRole("menu").element().contains(document.activeElement))
      .toBe(true);
    expect(openerFocus).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("{Escape}");
    await expect(current).resolves.toBeNull();
    await expect.element(opener).toHaveFocus();
    expect(openerFocus).toHaveBeenCalledTimes(2);
  });

  it("returns keyboard focus to the parent item when only a submenu closes", async () => {
    const pending = showContextMenuFallback([
      {
        id: "move",
        label: "Move chat",
        children: [{ id: "move:first", label: "First project" }],
      },
    ]);
    const parent = page.getByRole("menuitem", { name: "Move chat" });
    await expect
      .poll(() => page.getByRole("menu").element().contains(document.activeElement))
      .toBe(true);
    await userEvent.keyboard("{Home}{ArrowRight}");
    await expect.element(page.getByRole("menuitem", { name: "First project" })).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    await expect.element(parent).toHaveFocus();
    await expect
      .element(page.getByRole("menuitem", { name: "First project" }))
      .not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await expect(pending).resolves.toBeNull();
  });

  it.each([80, 100, 130])(
    "keeps the themed panel inside a small viewport at %s%% scale",
    async (scale) => {
      await page.viewport(400, 350);
      document.documentElement.classList.add("dark");
      applyInterfaceScalePercent(scale);
      const promise = showContextMenuFallback(
        [
          { id: "rename", label: "Rename chat…" },
          { id: "fork", label: "Fork chat" },
          { id: "copy-path", label: "Copy path" },
          { id: "archive", label: "Archive chat" },
          { id: "delete", label: "Move to Recycle Bin", destructive: true },
          { id: "delete-forever", label: "Delete permanently…", destructive: true },
        ],
        { x: 398, y: 348 },
      );
      const panel = page.getByRole("menu");
      await expect.element(panel).toBeVisible();
      await expect
        .poll(() => panel.element().getBoundingClientRect().right)
        .toBeLessThanOrEqual(400);
      const rect = panel.element().getBoundingClientRect();
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.bottom).toBeLessThanOrEqual(350);
      expect(rect.top).toBeGreaterThanOrEqual(0);
      expect(getComputedStyle(panel.element()).borderRadius).not.toBe("0px");
      // The fallback uses the shared Menu surface: the opaque, themed popover
      // colour rather than a translucent blurred panel.
      const surfaceProbe = document.createElement("div");
      surfaceProbe.className = "bg-popover";
      document.body.append(surfaceProbe);
      expect(getComputedStyle(panel.element()).backgroundColor).toBe(
        getComputedStyle(surfaceProbe).backgroundColor,
      );
      surfaceProbe.remove();
      expect(panel.element().querySelectorAll('[role="separator"]')).toHaveLength(2);
      await userEvent.keyboard("{Escape}");
      await expect(promise).resolves.toBeNull();
    },
  );

  it("scrolls a long action list without placing actions outside the viewport", async () => {
    await page.viewport(400, 350);
    applyInterfaceScalePercent(130);
    const promise = showContextMenuFallback(
      Array.from({ length: 24 }, (_, index) => ({
        id: `move-${index}`,
        label: `Move to group ${index + 1}`,
      })),
      { x: 398, y: 348 },
    );
    const panel = page.getByRole("menu");
    await expect.element(panel).toBeVisible();
    await expect
      .poll(() => panel.element().getBoundingClientRect().bottom)
      .toBeLessThanOrEqual(350);
    expect(panel.element().getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
    await page.getByRole("menuitem", { name: "Move to group 24", exact: true }).click();
    await expect(promise).resolves.toBe("move-23");
  });

  it.each([
    { theme: "light", scale: 100 },
    { theme: "light", scale: 130 },
    { theme: "dark", scale: 100 },
    { theme: "dark", scale: 130 },
  ])("captures the $theme menu at $scale%% for visual review", async ({ theme, scale }) => {
    await page.viewport(700, 650);
    document.documentElement.classList.toggle("dark", theme === "dark");
    applyInterfaceScalePercent(scale);
    const promise = showContextMenuFallback(
      [
        { id: "rename", label: "Rename chat…" },
        { id: "fork", label: "Fork chat" },
        { id: "copy-path", label: "Copy path" },
        { id: "copy-thread-id", label: "Copy chat ID" },
        { id: "archive", label: "Archive chat" },
        { id: "delete", label: "Move to Recycle Bin", destructive: true },
        { id: "delete-forever", label: "Delete permanently…", destructive: true },
        { id: "close", label: "Close tab" },
      ],
      { x: 180, y: 100 },
    );
    await expect.element(page.getByRole("menu")).toBeVisible();
    const permanentLabel = page
      .getByRole("menuitem", { name: "Delete permanently…" })
      .element()
      .querySelector("span")!;
    expect(permanentLabel.scrollWidth).toBeLessThanOrEqual(permanentLabel.clientWidth);
    await page.screenshot({
      path: `../../../../.explorations/117-context-menus/${theme}-${scale}.png`,
    });
    await userEvent.keyboard("{Escape}");
    await expect(promise).resolves.toBeNull();
  });
});
