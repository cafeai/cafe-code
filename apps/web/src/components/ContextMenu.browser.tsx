import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type TestContext } from "vitest";
import { render as renderComponent } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import { showContextMenuFallback as showContextMenu } from "../contextMenuFallback";
import "../index.css";
import { applyInterfaceScalePercent } from "../interfaceScale";

type MenuOperation = "render" | "click" | "keyboard" | "viewport" | "check";
type MenuPhase =
  | `${MenuOperation}-${"entered" | "settled"}`
  | "menu-opened"
  | "menu-settled"
  | "pointerdown"
  | "pointerup"
  | "click"
  | "retired";
type MenuFixture = ReturnType<typeof createMenuFixture>;
let activeFixture: MenuFixture | undefined;

/** A deadline retires admission, not an already issued native click. Keep this
 * exact owner leased through input drain, menu cancellation and root unmount. */
function createMenuFixture(context: TestContext) {
  const pendingInput = new Set<Promise<unknown>>();
  const pendingChecks = new Set<Promise<unknown>>();
  const choices = new Set<Promise<unknown>>();
  const mounts = new Set<Awaited<ReturnType<typeof renderComponent>>>();
  const hosts = new Set<HTMLElement>();
  const started = performance.now();
  const records: Array<{
    phase: MenuPhase;
    elapsedMs: number;
    pending: number;
    choices: number;
    hosts: number;
    menus: number;
    focusInOwnedHost: boolean;
    targetConnected: boolean;
    targetLeft: number | null;
    targetTop: number | null;
    targetWidth: number | null;
    targetHeight: number | null;
    trustedPresses: number;
    trustedClicks: number;
  }> = [];
  let target: Element | null = null;
  let trustedPresses = 0;
  let trustedClicks = 0;
  let retired = false;
  let completion: Promise<void> | undefined;
  const finite = (value: number | undefined) =>
    value !== undefined && Number.isFinite(value) ? Math.max(-1e9, Math.min(1e9, value)) : null;
  const mark = (phase: MenuPhase) => {
    if (retired) return;
    try {
      const rect = target?.getBoundingClientRect();
      if (records.length === 16) records.shift();
      records.push({
        phase,
        elapsedMs: Math.max(0, finite(performance.now() - started) ?? 0),
        pending: Math.min(pendingInput.size + pendingChecks.size, 1_000),
        choices: Math.min(choices.size, 1_000),
        hosts: Math.min([...hosts].filter((host) => host.isConnected).length, 1_000),
        menus: Math.min(document.querySelectorAll('[role="menu"]').length, 1_000),
        focusInOwnedHost: [...hosts].some((host) => host.contains(document.activeElement)),
        targetConnected: target?.isConnected ?? false,
        targetLeft: finite(rect?.left),
        targetTop: finite(rect?.top),
        targetWidth: finite(rect?.width),
        targetHeight: finite(rect?.height),
        trustedPresses,
        trustedClicks,
      });
    } catch {
      /* Passive evidence must not change the original operation. */
    }
  };
  const observePointer = (event: Event) => {
    if (retired || !target || !event.composedPath().includes(target)) return;
    if (event.type === "pointerdown") {
      if (event.isTrusted) trustedPresses = Math.min(1_000, trustedPresses + 1);
      mark("pointerdown");
    } else if (event.type === "pointerup") {
      mark("pointerup");
    } else if (event.type === "click") {
      if (event.isTrusted) trustedClicks = Math.min(1_000, trustedClicks + 1);
      mark("click");
    }
  };
  const assertActive = () => {
    if (retired || context.signal.aborted) throw new Error("Context menu fixture has retired.");
  };
  const observe = async <T,>(phase: MenuOperation, operation: () => PromiseLike<T>): Promise<T> => {
    assertActive();
    mark(`${phase}-entered`);
    const original = Promise.resolve(operation());
    const pending = phase === "check" ? pendingChecks : pendingInput;
    pending.add(original);
    try {
      const result = await original;
      assertActive();
      mark(`${phase}-settled`);
      return result;
    } finally {
      pending.delete(original);
    }
  };
  const retire = () => {
    if (retired) return;
    mark("retired");
    retired = true;
    context.signal.removeEventListener("abort", retire);
    document.removeEventListener("pointerdown", observePointer, true);
    document.removeEventListener("pointerup", observePointer, true);
    document.removeEventListener("click", observePointer, true);
  };
  const cleanup = (): Promise<void> => {
    retire();
    return (completion ??= Promise.resolve().then(async () => {
      await Promise.allSettled([...pendingInput]);
      if (
        [...document.querySelectorAll<HTMLElement>("[data-context-menu-host]")].some(
          (host) => !hosts.has(host),
        )
      ) {
        throw new Error("A foreign context menu host prevents fixture cleanup.");
      }
      // Preserve the original one cleanup Escape, after original input closes.
      // It may close only a submenu. The existing empty-menu path then retires
      // the still-owned imperative root without creating a replacement or input.
      await userEvent.keyboard("{Escape}");
      if (
        [...document.querySelectorAll<HTMLElement>("[data-context-menu-host]")].some(
          (host) => !hosts.has(host),
        )
      ) {
        throw new Error("A foreign context menu host prevents fixture cleanup.");
      }
      await showContextMenu([]);
      await Promise.allSettled([...choices, ...pendingChecks]);
      for (const mount of mounts) await mount.unmount();
      mounts.clear();
      if ([...hosts].some((host) => host.isConnected)) {
        throw new Error("An owned context menu host did not retire.");
      }
      document.documentElement.classList.remove("dark");
      applyInterfaceScalePercent(100);
      if (activeFixture === fixture) activeFixture = undefined;
    }));
  };
  const fixture = {
    assertActive,
    observe,
    cleanup,
    async render(...args: Parameters<typeof renderComponent>) {
      return observe("render", async () => {
        const mount = await renderComponent(...args);
        mounts.add(mount);
        return mount;
      });
    },
    showMenu(...args: Parameters<typeof showContextMenu>) {
      assertActive();
      const existing = new Set(document.querySelectorAll<HTMLElement>("[data-context-menu-host]"));
      if ([...existing].some((host) => !hosts.has(host))) {
        throw new Error("A foreign context menu host prevents fixture admission.");
      }
      const result = showContextMenu(...args);
      for (const host of document.querySelectorAll<HTMLElement>("[data-context-menu-host]")) {
        if (!existing.has(host)) hosts.add(host);
      }
      choices.add(result);
      void result.then(
        () => {
          choices.delete(result);
          mark("menu-settled");
        },
        () => {
          choices.delete(result);
        },
      );
      target = document.activeElement;
      mark("menu-opened");
      return result;
    },
    click(element: { click(): PromiseLike<void>; element(): Element }) {
      assertActive();
      // This passive snapshot must not replace the locator's original native
      // auto-wait with an immediate element-existence requirement.
      try {
        target = element.element();
      } catch {
        target = null;
      }
      return observe("click", () => element.click());
    },
  };
  context.onTestFinished(cleanup);
  context.onTestFailed(() => {
    try {
      console.error("context-menu-fixture-diagnostic", { records });
    } catch {
      /* Diagnostic delivery must preserve the original failure. */
    }
  });
  context.signal.addEventListener("abort", retire, { once: true });
  document.addEventListener("pointerdown", observePointer, { capture: true, passive: true });
  document.addEventListener("pointerup", observePointer, { capture: true, passive: true });
  document.addEventListener("click", observePointer, { capture: true, passive: true });
  if (context.signal.aborted) retire();
  return fixture;
}

function currentFixture(): MenuFixture {
  if (!activeFixture) throw new Error("Context menu fixture is unavailable.");
  activeFixture.assertActive();
  return activeFixture;
}

beforeEach((context) => {
  if (activeFixture) throw new Error("The previous context menu fixture still owns cleanup.");
  if (document.querySelector("[data-context-menu-host]")) {
    throw new Error("A foreign context menu host prevents fixture admission.");
  }
  activeFixture = createMenuFixture(context);
});

afterEach(async () => {
  await activeFixture?.cleanup();
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
    const fixture = currentFixture();
    const screen = await fixture.render(<button type="button">Open menu</button>);
    await fixture.click(screen.getByRole("button", { name: "Open menu" }));
    const promise = fixture.showMenu(
      [
        { id: "rename", label: "Rename <script> chat" },
        { id: "delete", label: "Delete permanently…", destructive: true },
      ],
      { x: 30, y: 30 },
    );
    const row = page.getByRole("menuitem", { name: "Rename <script> chat" });
    await fixture.observe("check", () => expect.element(row).toBeVisible());
    expect(row.element().querySelector("svg")).not.toBeNull();
    expect(row.element().querySelector("script")).toBeNull();
    await fixture.click(row);
    await fixture.observe("check", () => expect(promise).resolves.toBe("rename"));
    await fixture.observe("check", () =>
      expect.element(page.getByRole("menu")).not.toBeInTheDocument(),
    );
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Open menu" }).element(),
    );
  });

  it("supports keyboard selection, disabled rows and Escape dismissal", async () => {
    const fixture = currentFixture();
    const promise = fixture.showMenu([
      { id: "rename", label: "Rename" },
      { id: "archive", label: "Archive", disabled: true },
      { id: "delete", label: "Move to Recycle Bin", destructive: true },
    ]);
    await fixture.observe("check", () =>
      expect.element(page.getByRole("menuitem", { name: "Rename" })).toBeVisible(),
    );
    await fixture.observe("check", () =>
      expect
        .poll(() => page.getByRole("menu").element().contains(document.activeElement))
        .toBe(true),
    );
    await fixture.observe("keyboard", () => userEvent.keyboard("{Home}{ArrowDown}"));
    // Base UI deliberately keeps disabled actions keyboard-discoverable.
    await fixture.observe("check", () =>
      expect.element(page.getByRole("menuitem", { name: "Archive", exact: true })).toHaveFocus(),
    );
    await fixture.observe("keyboard", () => userEvent.keyboard("{Enter}"));
    await fixture.observe("check", () => expect.element(page.getByRole("menu")).toBeVisible());
    await fixture.observe("keyboard", () => userEvent.keyboard("{ArrowDown}"));
    await fixture.observe("check", () =>
      expect.element(page.getByRole("menuitem", { name: "Move to Recycle Bin" })).toHaveFocus(),
    );
    await fixture.observe("keyboard", () => userEvent.keyboard("{Enter}"));
    await fixture.observe("check", () => expect(promise).resolves.toBe("delete"));
    const dismissed = fixture.showMenu([{ id: "rename", label: "Rename" }]);
    await fixture.observe("check", () => expect.element(page.getByRole("menu")).toBeVisible());
    await fixture.observe("keyboard", () => userEvent.keyboard("{Escape}"));
    await fixture.observe("check", () => expect(dismissed).resolves.toBeNull());
  });

  it("ignores the opening synthesized click without a new primary press", async () => {
    const fixture = currentFixture();
    const promise = fixture.showMenu([
      { id: "delete", label: "Delete permanently…", destructive: true },
    ]);
    const action = page.getByRole("menuitem", { name: "Delete permanently…" });
    await fixture.observe("check", () => expect.element(action).toBeVisible());
    action
      .element()
      .dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 }),
      );
    await fixture.observe("check", () => expect.element(action).toBeVisible());
    await fixture.click(action);
    await fixture.observe("check", () => expect(promise).resolves.toBe("delete"));
  });

  it("opens nested submenus with the keyboard and returns the exact leaf", async () => {
    const fixture = currentFixture();
    const promise = fixture.showMenu([
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
    await fixture.observe("check", () => expect.element(parent).toBeVisible());
    await fixture.observe("check", () =>
      expect
        .poll(() => page.getByRole("menu").element().contains(document.activeElement))
        .toBe(true),
    );
    await fixture.observe("keyboard", () => userEvent.keyboard("{Home}{ArrowRight}"));
    await fixture.observe("check", () =>
      expect.element(page.getByRole("menuitem", { name: "Second project" })).toBeVisible(),
    );
    await fixture.click(page.getByRole("menuitem", { name: "Second project" }));
    await fixture.observe("check", () => expect(promise).resolves.toBe("move:second"));
  });

  it("cancels an older menu when a new one opens and dismisses on outside click", async () => {
    const fixture = currentFixture();
    const screen = await fixture.render(<button type="button">Outside</button>);
    const previous = fixture.showMenu([{ id: "old", label: "Old action" }]);
    await fixture.observe("check", () =>
      expect.element(page.getByRole("menuitem", { name: "Old action" })).toBeVisible(),
    );
    const current = fixture.showMenu([{ id: "new", label: "New action" }], {
      x: 300,
      y: 200,
    });
    await fixture.observe("check", () => expect(previous).resolves.toBeNull());
    await fixture.observe("check", () =>
      expect.element(page.getByRole("menuitem", { name: "New action" })).toBeVisible(),
    );
    await fixture.click(screen.getByRole("button", { name: "Outside" }));
    await fixture.observe("check", () => expect(current).resolves.toBeNull());
  });

  it.each(["pointer", "programmatic"] as const)(
    "preserves %s outside input focus without briefly refocusing the original composer",
    async (transfer) => {
      const fixture = currentFixture();
      const firstFocus = vi.fn();
      const secondFocus = vi.fn();
      const screen = await fixture.render(
        <div>
          <input aria-label="First composer" onFocus={firstFocus} />
          <input aria-label="Second composer" onFocus={secondFocus} />
        </div>,
      );
      await fixture.click(screen.getByRole("textbox", { name: "First composer" }));
      const pending = fixture.showMenu([{ id: "rename", label: "Rename" }], {
        x: 300,
        y: 200,
      });
      await fixture.observe("check", () =>
        expect
          .poll(() => page.getByRole("menu").element().contains(document.activeElement))
          .toBe(true),
      );
      const second = screen.getByRole("textbox", { name: "Second composer" });
      if (transfer === "pointer") {
        await fixture.click(second);
      } else {
        // Focus may leave through keyboard navigation or another UI control,
        // without the pointer event that normally dismisses the menu first.
        // Escape must not steal that new focus even if the menu is still open.
        second.element().focus();
        await fixture.observe("keyboard", () => userEvent.keyboard("{Escape}"));
      }
      await fixture.observe("check", () => expect(pending).resolves.toBeNull());
      await fixture.observe("check", () => expect.element(second).toHaveFocus());
      // A transient return to the first composer can activate its pane even if
      // the browser subsequently focuses the actual pointer target again.
      expect(firstFocus).toHaveBeenCalledTimes(1);
      expect(secondFocus).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves an outside pane activation when its transcript is not focusable", async () => {
    const fixture = currentFixture();
    const screen = await fixture.render(<ContextMenuPaneFixture />);
    await fixture.click(screen.getByRole("textbox", { name: "First composer" }));
    const pending = fixture.showMenu([{ id: "rename", label: "Rename" }], {
      x: 300,
      y: 200,
    });
    await fixture.observe("check", () =>
      expect
        .poll(() => page.getByRole("menu").element().contains(document.activeElement))
        .toBe(true),
    );
    await fixture.click(screen.getByText("Second pane transcript", { exact: true }));
    await fixture.observe("check", () => expect(pending).resolves.toBeNull());
    await fixture.observe("check", () =>
      expect.element(screen.getByRole("status")).toHaveTextContent("Active pane: second"),
    );
    await fixture.observe("check", () =>
      expect.element(screen.getByRole("textbox", { name: "First composer" })).not.toHaveFocus(),
    );
  });

  it.each(["escape", "selection"] as const)(
    "restores the original opener after replacement menu %s without a focus flash",
    async (close) => {
      const fixture = currentFixture();
      const openerFocus = vi.fn();
      const screen = await fixture.render(
        <button type="button" onFocus={openerFocus}>
          Original opener
        </button>,
      );
      const opener = screen.getByRole("button", { name: "Original opener" });
      await fixture.click(opener);
      const previous = fixture.showMenu([{ id: "old", label: "Old action" }]);
      await fixture.observe("check", () =>
        expect
          .poll(() => page.getByRole("menu").element().contains(document.activeElement))
          .toBe(true),
      );
      const current = fixture.showMenu([{ id: "new", label: "New action" }]);
      await fixture.observe("check", () => expect(previous).resolves.toBeNull());
      await fixture.observe("check", () =>
        expect.element(page.getByRole("menuitem", { name: "New action" })).toBeVisible(),
      );
      await fixture.observe("check", () =>
        expect
          .poll(() => page.getByRole("menu").element().contains(document.activeElement))
          .toBe(true),
      );
      expect(openerFocus).toHaveBeenCalledTimes(1);
      await fixture.observe("keyboard", () =>
        userEvent.keyboard(close === "escape" ? "{Escape}" : "{Home}{Enter}"),
      );
      await fixture.observe("check", () =>
        expect(current).resolves.toBe(close === "escape" ? null : "new"),
      );
      await fixture.observe("check", () => expect.element(opener).toHaveFocus());
      expect(openerFocus).toHaveBeenCalledTimes(2);
    },
  );

  it("retains the opener across rapid replacements of a focused portalled submenu", async () => {
    const fixture = currentFixture();
    const openerFocus = vi.fn();
    const screen = await fixture.render(
      <button type="button" onFocus={openerFocus}>
        Original opener
      </button>,
    );
    const opener = screen.getByRole("button", { name: "Original opener" });
    await fixture.click(opener);
    const previous = fixture.showMenu([
      {
        id: "move",
        label: "Move chat",
        children: [{ id: "move:first", label: "First project" }],
      },
    ]);
    await fixture.observe("check", () =>
      expect
        .poll(() => page.getByRole("menu").element().contains(document.activeElement))
        .toBe(true),
    );
    await fixture.observe("keyboard", () => userEvent.keyboard("{Home}{ArrowRight}"));
    await fixture.observe("check", () =>
      expect.element(page.getByRole("menuitem", { name: "First project" })).toHaveFocus(),
    );
    const intermediate = fixture.showMenu([{ id: "middle", label: "Middle action" }]);
    const current = fixture.showMenu([{ id: "new", label: "New action" }]);
    await fixture.observe("check", () => expect(previous).resolves.toBeNull());
    await fixture.observe("check", () => expect(intermediate).resolves.toBeNull());
    await fixture.observe("check", () =>
      expect.element(page.getByRole("menuitem", { name: "New action" })).toBeVisible(),
    );
    await fixture.observe("check", () =>
      expect
        .poll(() => page.getByRole("menu").element().contains(document.activeElement))
        .toBe(true),
    );
    expect(openerFocus).toHaveBeenCalledTimes(1);
    await fixture.observe("keyboard", () => userEvent.keyboard("{Escape}"));
    await fixture.observe("check", () => expect(current).resolves.toBeNull());
    await fixture.observe("check", () => expect.element(opener).toHaveFocus());
    expect(openerFocus).toHaveBeenCalledTimes(2);
  });

  it("returns keyboard focus to the parent item when only a submenu closes", async () => {
    const fixture = currentFixture();
    const pending = fixture.showMenu([
      {
        id: "move",
        label: "Move chat",
        children: [{ id: "move:first", label: "First project" }],
      },
    ]);
    const parent = page.getByRole("menuitem", { name: "Move chat" });
    await fixture.observe("check", () =>
      expect
        .poll(() => page.getByRole("menu").element().contains(document.activeElement))
        .toBe(true),
    );
    await fixture.observe("keyboard", () => userEvent.keyboard("{Home}{ArrowRight}"));
    await fixture.observe("check", () =>
      expect.element(page.getByRole("menuitem", { name: "First project" })).toHaveFocus(),
    );
    await fixture.observe("keyboard", () => userEvent.keyboard("{ArrowLeft}"));
    await fixture.observe("check", () => expect.element(parent).toHaveFocus());
    await fixture.observe("check", () =>
      expect.element(page.getByRole("menuitem", { name: "First project" })).not.toBeInTheDocument(),
    );
    await fixture.observe("keyboard", () => userEvent.keyboard("{Escape}"));
    await fixture.observe("check", () => expect(pending).resolves.toBeNull());
  });

  it.each([80, 100, 130])(
    "keeps the themed panel inside a small viewport at %s%% scale",
    async (scale) => {
      const fixture = currentFixture();
      await fixture.observe("viewport", () => page.viewport(400, 350));
      document.documentElement.classList.add("dark");
      applyInterfaceScalePercent(scale);
      const promise = fixture.showMenu(
        [
          { id: "rename", label: "Rename chat…" },
          { id: "duplicate", label: "Duplicate chat" },
          { id: "copy-path", label: "Copy path" },
          { id: "archive", label: "Archive chat" },
          { id: "delete", label: "Move to Recycle Bin", destructive: true },
          { id: "delete-forever", label: "Delete permanently…", destructive: true },
        ],
        { x: 398, y: 348 },
      );
      const panel = page.getByRole("menu");
      await fixture.observe("check", () => expect.element(panel).toBeVisible());
      await fixture.observe("check", () =>
        expect.poll(() => panel.element().getBoundingClientRect().right).toBeLessThanOrEqual(400),
      );
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
      await fixture.observe("keyboard", () => userEvent.keyboard("{Escape}"));
      await fixture.observe("check", () => expect(promise).resolves.toBeNull());
    },
  );

  it("scrolls a long action list without placing actions outside the viewport", async () => {
    const fixture = currentFixture();
    await fixture.observe("viewport", () => page.viewport(400, 350));
    applyInterfaceScalePercent(130);
    const promise = fixture.showMenu(
      Array.from({ length: 24 }, (_, index) => ({
        id: `move-${index}`,
        label: `Move to group ${index + 1}`,
      })),
      { x: 398, y: 348 },
    );
    const panel = page.getByRole("menu");
    await fixture.observe("check", () => expect.element(panel).toBeVisible());
    await fixture.observe("check", () =>
      expect.poll(() => panel.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(350),
    );
    expect(panel.element().getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
    await fixture.click(page.getByRole("menuitem", { name: "Move to group 24", exact: true }));
    await fixture.observe("check", () => expect(promise).resolves.toBe("move-23"));
  });
});
