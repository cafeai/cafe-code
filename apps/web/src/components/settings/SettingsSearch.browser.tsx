import "../../index.css";

import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type TestContext } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

const fixture = vi.hoisted(() => ({
  pathname: "/settings/general",
  /** False simulates a narrow window's sidebar sheet unmounting on close. */
  showNav: true,
  listeners: new Set<() => void>(),
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => fixture.navigate,
  useCanGoBack: () => true,
}));

import { SidebarProvider } from "../ui/sidebar";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { SETTINGS_SEARCH_HIGHLIGHT_ATTRIBUTE } from "./settingsSearchLanding";
import { useSettingsSearchFocusStore } from "./settingsSearchStore";
import { SettingsSidebarNav } from "./SettingsSidebarNav";

function useFixture<T>(read: () => T): T {
  return useSyncExternalStore((listener) => {
    fixture.listeners.add(listener);
    return () => fixture.listeners.delete(listener);
  }, read);
}

function notify() {
  for (const listener of fixture.listeners) listener();
}

/** Synthetic pages: only the anchors and controls matter to the search. */
function Page({ pathname }: { pathname: string }) {
  if (pathname !== "/settings/appearance") {
    return (
      <SettingsPageContainer title="General">
        <SettingsSection title="Language & time">
          <SettingsRow searchId="general.timeFormat" title="Time format" />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }
  return (
    <SettingsPageContainer title="Appearance">
      <SettingsSection title="Interface">
        <SettingsRow
          searchId="appearance.accentColor"
          title="Accent color"
          control={<button type="button">Accent picker</button>}
        />
      </SettingsSection>
      {/* Pushes the next row below the fold so opening it must scroll. */}
      <div style={{ height: 1600 }} />
      <SettingsSection title="Sidebar">
        <SettingsRow
          searchId="appearance.sidebarEffectsColor"
          title="Sidebar effects color"
          control={<button type="button">Effects picker</button>}
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function Harness() {
  const pathname = useFixture(() => fixture.pathname);
  const showNav = useFixture(() => fixture.showNav);
  return (
    <SidebarProvider defaultOpen>
      <div style={{ display: "flex", width: "100vw", height: "100vh" }}>
        <nav style={{ width: 256, display: "flex", flexDirection: "column", minHeight: 0 }}>
          {showNav ? <SettingsSidebarNav pathname={pathname} /> : null}
        </nav>
        <main style={{ flex: 1, display: "flex", minHeight: 0 }}>
          <Page pathname={pathname} />
        </main>
      </div>
    </SidebarProvider>
  );
}

async function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(<Harness />, { container: host });
  return {
    async cleanup() {
      await screen.unmount();
      host.remove();
    },
  };
}

/** Exact ownership for the three asynchronous native-search journeys below.
 * Retirement cannot cancel an admitted native command, so join its original
 * promise before another fixture can provide replacement matching controls. */
function ownSettingsSearchMount(
  host: HTMLElement,
  { signal, onTestFinished }: Pick<TestContext, "signal" | "onTestFinished">,
  retireObservation: () => void,
) {
  let retired = false;
  let pendingRender: ReturnType<typeof render> | null = null;
  let ownedMount: Awaited<ReturnType<typeof render>> | null = null;
  let pendingUnmount: Promise<void> | null = null;
  const pendingNative = new Set<Promise<unknown>>();
  const assertActive = () => {
    if (retired || signal.aborted) throw new Error("Settings search fixture has retired.");
  };
  const retire = () => {
    if (retired) return;
    retired = true;
    retireObservation();
    signal.removeEventListener("abort", retire);
  };
  const native = async <T,>(operation: () => Promise<T>): Promise<T> => {
    assertActive();
    const pending = operation();
    pendingNative.add(pending);
    try {
      const result = await pending;
      assertActive();
      return result;
    } finally {
      pendingNative.delete(pending);
    }
  };
  const cleanup = () => {
    retire();
    return (pendingUnmount ??= (async () => {
      await Promise.allSettled([...pendingNative]);
      // Only cleanup consumes a rejected render here; its original mount await
      // still rejects the test rather than treating failed rendering as ready.
      const view = ownedMount ?? (pendingRender ? await pendingRender.catch(() => null) : null);
      try {
        if (view) await view.unmount();
      } finally {
        ownedMount = null;
        pendingRender = null;
        host.remove();
      }
    })());
  };
  onTestFinished(cleanup);
  signal.addEventListener("abort", retire, { once: true });
  if (signal.aborted) retire();
  return {
    assertActive,
    native,
    cleanup,
    async mount() {
      assertActive();
      document.body.append(host);
      pendingRender = render(<Harness />, { container: host });
      ownedMount = await pendingRender;
      assertActive();
    },
  };
}

type SettingsSearchNavigation = { readonly to: string; readonly replace?: boolean };

/** Observe one exact navigation effect, not the later native command ACK.
 * The mock still receives the original arguments and returns its exact result;
 * this observer neither performs navigation nor extends the highlight timer. */
function observeAppearanceNavigation({
  signal,
  onTestFinished,
}: Pick<TestContext, "signal" | "onTestFinished">) {
  const original = fixture.navigate.getMockImplementation();
  if (!original) throw new Error("The exact settings navigation implementation is unavailable.");
  let resolveNavigation!: (request: SettingsSearchNavigation) => void;
  let rejectNavigation!: (error: unknown) => void;
  let settled = false;
  let claimed = false;
  let actionBound = false;
  let retired = false;
  const completed = new Promise<SettingsSearchNavigation>((resolve, reject) => {
    resolveNavigation = resolve;
    rejectNavigation = reject;
  });
  // Native failure/retirement may precede the observation await. Retain its
  // rejection for that await without creating an unhandled detached tail.
  void completed.catch(() => undefined);
  const refuse = (error: unknown) => {
    if (settled) return;
    settled = true;
    rejectNavigation(error);
  };
  const wrapped = (...args: Parameters<typeof original>) => {
    const request = args[0];
    const observe =
      !retired && !claimed && request?.to === "/settings/appearance" && request.replace === true;
    if (observe) claimed = true;
    let result: ReturnType<typeof original>;
    try {
      result = original(...args);
    } catch (error) {
      refuse(error);
      throw error;
    }
    void Promise.resolve(result).then(() => {
      if (observe && !retired && !settled) {
        settled = true;
        resolveNavigation(request);
      }
    }, refuse);
    return result;
  };
  const retire = () => {
    if (retired) return;
    retired = true;
    signal.removeEventListener("abort", retire);
    refuse(new Error("The exact settings navigation observation was retired."));
    // An old observation may never replace a later test's mock implementation.
    if (fixture.navigate.getMockImplementation() === wrapped)
      fixture.navigate.mockImplementation(original);
  };
  fixture.navigate.mockImplementation(wrapped);
  onTestFinished(retire);
  signal.addEventListener("abort", retire, { once: true });
  if (signal.aborted) retire();
  return {
    observe(action: Promise<unknown>) {
      if (retired || actionBound)
        throw new Error("The exact settings navigation observation cannot be reused.");
      actionBound = true;
      void action.then(() => {
        if (!claimed && !settled)
          refuse(new Error("The native action did not reach its exact settings navigation."));
      }, refuse);
      return completed;
    },
  };
}

const searchInput = () => page.getByRole("combobox", { name: "Search settings" });
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
const effectsRow = () =>
  document.querySelector<HTMLElement>('[data-settings-search-id="appearance.sidebarEffectsColor"]');
const optionTitles = () =>
  [...document.querySelectorAll<HTMLElement>('[role="option"]')].map((option) =>
    option.querySelector("span > span")?.textContent?.trim(),
  );

/** Passive evidence only: focus follows scrollIntoView before native smooth
 * scrolling necessarily finishes. These bounded receipts distinguish the
 * actual scroll owner, viewport and layout without adding input or readiness. */
function observeSettingsSearchScroll(host: HTMLElement) {
  const started = performance.now();
  const observations: unknown[] = [];
  let row: HTMLElement | null = null;
  let owner: HTMLElement | null = null;
  let retired = false;
  let reported = false;
  let dropped = 0;
  const finite = (value: number | undefined) =>
    value !== undefined && Number.isFinite(value) ? value : null;
  const metrics = (element: Element | null) => {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return {
      connected: element.isConnected,
      top: finite(rect.top),
      bottom: finite(rect.bottom),
      height: finite(rect.height),
      scrollTop: finite(element.scrollTop),
      scrollHeight: finite(element.scrollHeight),
      clientHeight: finite(element.clientHeight),
    };
  };
  const readRow = () =>
    host.querySelector<HTMLElement>('[data-settings-search-id="appearance.sidebarEffectsColor"]');
  const scrollOwner = (target: HTMLElement | null) => {
    // No selector-derived identity is logged. Include overflow:hidden only
    // when it really has a vertical scroll range, as scrollIntoView can move it.
    let parent = target?.parentElement ?? null;
    for (let depth = 0; parent && depth < 32; depth++, parent = parent.parentElement) {
      if (
        /^(auto|scroll|hidden)$/.test(getComputedStyle(parent).overflowY) &&
        parent.scrollHeight > parent.clientHeight
      )
        return parent;
    }
    return null;
  };
  type Phase =
    | "mounted"
    | "before-fill"
    | "after-fill"
    | "results-observed"
    | "before-arrow-down"
    | "after-arrow-down"
    | "selection-observed"
    | "before-enter"
    | "after-enter"
    | "target-bound"
    | "navigate-observed"
    | "focus-observed"
    | "visible-observed"
    | "highlight-cleared"
    | "scroll"
    | "scrollend"
    | "resize"
    | "window-focus"
    | "window-blur"
    | "page-hide"
    | "final";
  const frameState = () => {
    try {
      // frameElement belongs to the parent realm, so a child-realm instanceof
      // check would falsely reject a real iframe. Inspect only fixed ownership
      // booleans and geometry, never its URL, title or received attributes.
      const frame = window.frameElement;
      return frame
        ? {
            iframe: frame.localName === "iframe",
            connected: frame.isConnected,
            nativeTarget: frame.getAttribute("data-vitest") === "true",
            namedTarget: frame.getAttribute("name") === "vitest-iframe",
            firstNativeTarget: frame.ownerDocument.querySelector('[data-vitest="true"]') === frame,
            parentWindow: frame.ownerDocument.defaultView === window.parent,
            geometry: metrics(frame),
          }
        : null;
    } catch {
      // Opaque/retired parent access is unknown, not evidence of another owner.
      return null;
    }
  };
  const record = (phase: Phase, event?: Event) => {
    if (retired) return;
    // Reserve the last of 32 records for exact pre-unmount state, even if
    // native smooth scrolling emits more events than the bounded inventory.
    if (phase !== "final" && observations.length >= 31) {
      dropped = Math.min(dropped + 1, 1_000_000);
      return;
    }
    observations.push({
      phase,
      elapsedMs: finite(performance.now() - started),
      row: metrics(row),
      owner: metrics(owner),
      ownerOverflowY: owner
        ? getComputedStyle(owner).overflowY === "auto"
          ? "auto"
          : getComputedStyle(owner).overflowY === "scroll"
            ? "scroll"
            : getComputedStyle(owner).overflowY === "hidden"
              ? "hidden"
              : "other"
        : null,
      sameRow: row !== null && readRow() === row,
      sameOwner: owner !== null && scrollOwner(row) === owner,
      focusedControl:
        row !== null &&
        document.activeElement === row.querySelector("[data-settings-row-control] button"),
      documentFocused: document.hasFocus(),
      visible: document.visibilityState === "visible",
      viewportHeight: finite(window.innerHeight),
      documentHeight: finite(document.documentElement.clientHeight),
      visualViewportHeight: finite(window.visualViewport?.height),
      visualViewportOffsetTop: finite(window.visualViewport?.offsetTop),
      documentScrollTop: finite(document.scrollingElement?.scrollTop),
      documentReady: document.readyState,
      documentConnected: document.isConnected,
      frame: frameState(),
      input: (() => {
        const input = host.querySelector<HTMLInputElement>("[data-settings-search-input]");
        return input
          ? {
              geometry: metrics(input),
              focused: document.activeElement === input,
              disabled: input.disabled,
              readOnly: input.readOnly,
              displayed:
                getComputedStyle(input).display !== "none" &&
                getComputedStyle(input).visibility === "visible",
            }
          : null;
      })(),
      reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      eventTarget:
        event === undefined
          ? null
          : event.target === owner
            ? "owner"
            : event.target === document || event.target === document.scrollingElement
              ? "document"
              : "ancestor",
      eventScrollOwner:
        row && event?.target instanceof HTMLElement && event.target.contains(row)
          ? metrics(event.target)
          : null,
      trusted: event?.isTrusted ?? null,
    });
  };
  const resize = new ResizeObserver(() => record("resize"));
  const bind = () => {
    if (retired) return;
    const nextRow = readRow();
    const nextOwner = scrollOwner(nextRow);
    if (nextRow === row && nextOwner === owner) return;
    resize.disconnect();
    row = nextRow;
    owner = nextOwner;
    if (row) resize.observe(row);
    if (owner && owner !== row) resize.observe(owner);
    record("target-bound");
  };
  const mutations = new MutationObserver(bind);
  mutations.observe(host, { childList: true, subtree: true });
  const scroll = (event: Event) => {
    if (retired || !row) return;
    if (
      event.target === document ||
      event.target === document.scrollingElement ||
      (event.target instanceof HTMLElement && event.target.contains(row))
    )
      record(event.type === "scrollend" ? "scrollend" : "scroll", event);
  };
  window.addEventListener("scroll", scroll, { capture: true, passive: true });
  window.addEventListener("scrollend", scroll, { capture: true, passive: true });
  const onFocus = () => record("window-focus");
  const onBlur = () => record("window-blur");
  const onPageHide = () => record("page-hide");
  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", onBlur);
  window.addEventListener("pagehide", onPageHide);
  const retire = () => {
    if (retired) return;
    record("final");
    retired = true;
    mutations.disconnect();
    resize.disconnect();
    window.removeEventListener("scroll", scroll, true);
    window.removeEventListener("scrollend", scroll, true);
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("pagehide", onPageHide);
  };
  return {
    mark: record,
    retire,
    fail() {
      retire();
      if (reported) return;
      reported = true;
      // Fixed, failure-only diagnostics contain no DOM, source, arbitrary IDs,
      // event text or received errors. A receipt is not a historical cause.
      console.info("settings-search-scroll-diagnostic", JSON.stringify({ observations, dropped }));
    },
  };
}

beforeEach(async () => {
  await page.viewport(1280, 800);
  fixture.pathname = "/settings/general";
  fixture.showNav = true;
  fixture.navigate.mockReset();
  fixture.navigate.mockImplementation(async ({ to }: { to: string }) => {
    fixture.pathname = to;
    notify();
  });
  useSettingsSearchFocusStore.setState({ request: 0, pending: false });
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Settings search", () => {
  it("filters as you type, moves with the arrow keys and opens the chosen setting", async ({
    onTestFailed,
    onTestFinished,
    signal,
  }) => {
    const host = document.createElement("div");
    const diagnostic = observeSettingsSearchScroll(host);
    const {
      assertActive,
      native,
      cleanup,
      mount: mountOwned,
    } = ownSettingsSearchMount(host, { signal, onTestFinished }, diagnostic.retire);
    // Capture this invocation's completion before append/render awaits. Hard
    // timeout cleanup joins only its pending render and retires listeners before
    // unmount; late continuations cannot dispatch input into a later fixture.
    onTestFailed(diagnostic.fail);
    try {
      await mountOwned();
      assertActive();
      diagnostic.mark("mounted");
      expect(page.getByRole("button", { name: "Keybindings" }).element()).toBeTruthy();
      diagnostic.mark("before-fill");
      await native(() => searchInput().fill("color"));
      assertActive();
      diagnostic.mark("after-fill");

      await vi.waitFor(() => {
        expect(optionTitles().slice(0, 2)).toEqual(["Accent color", "Sidebar effects color"]);
      });
      assertActive();
      diagnostic.mark("results-observed");
      // Results replace the menu while a query is present.
      expect(
        document.querySelector('[data-slot="sidebar-content"] [data-sidebar="menu-button"]'),
      ).toBeNull();
      expect(options()[0]?.getAttribute("aria-selected")).toBe("true");

      diagnostic.mark("before-arrow-down");
      await native(() => userEvent.keyboard("{ArrowDown}"));
      assertActive();
      diagnostic.mark("after-arrow-down");
      const input = searchInput().element() as HTMLInputElement;
      await vi.waitFor(() => {
        expect(options()[1]?.getAttribute("aria-selected")).toBe("true");
        expect(input.getAttribute("aria-activedescendant")).toBe(options()[1]?.id);
      });
      assertActive();
      diagnostic.mark("selection-observed");

      const navigation = observeAppearanceNavigation({ signal, onTestFinished });
      diagnostic.mark("before-enter");
      const entered = native(() => userEvent.keyboard("{Enter}"));
      await navigation.observe(entered);
      assertActive();
      await vi.waitFor(() => {
        expect(fixture.navigate).toHaveBeenCalledWith({
          to: "/settings/appearance",
          replace: true,
        });
      });
      assertActive();
      diagnostic.mark("navigate-observed");
      await vi.waitFor(() => {
        expect(effectsRow()?.hasAttribute(SETTINGS_SEARCH_HIGHLIGHT_ATTRIBUTE)).toBe(true);
        expect(document.activeElement?.textContent).toBe("Effects picker");
      });
      assertActive();
      diagnostic.mark("focus-observed");
      // The row was scrolled into the visible part of the page.
      await vi.waitFor(() => {
        const rect = effectsRow()!.getBoundingClientRect();
        expect(rect.top).toBeGreaterThanOrEqual(0);
        expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
      });
      assertActive();
      diagnostic.mark("visible-observed");
      // The search stays open with the opened result marked.
      expect(input.value).toBe("color");
      expect(options()[1]?.getAttribute("aria-current")).toBe("page");
      // The transient assertions observe actual navigation, not a possibly
      // delayed native ACK. That same original Enter must still succeed before
      // the next input; a native error is never converted into test success.
      await entered;
      assertActive();
      diagnostic.mark("after-enter");

      // Interacting with the page ends the highlight early.
      await native(() => page.getByRole("button", { name: "Accent picker" }).click());
      assertActive();
      await vi.waitFor(() => {
        expect(effectsRow()?.hasAttribute(SETTINGS_SEARCH_HIGHLIGHT_ATTRIBUTE)).toBe(false);
      });
      assertActive();
      diagnostic.mark("highlight-cleared");
    } catch (error) {
      diagnostic.fail();
      throw error;
    } finally {
      await cleanup();
    }
  });

  it("still reveals the setting when the sidebar unmounts as the result opens", async ({
    signal,
    onTestFinished,
  }) => {
    const host = document.createElement("div");
    const owner = ownSettingsSearchMount(host, { signal, onTestFinished }, () => undefined);
    try {
      await owner.mount();
      owner.assertActive();
      await owner.native(() => searchInput().fill("sidebar effects"));
      owner.assertActive();
      fixture.navigate.mockImplementation(async ({ to }: SettingsSearchNavigation) => {
        fixture.pathname = to;
        fixture.showNav = false;
        notify();
      });
      // Arm the receipt before the one original Enter. Preserve the exact
      // navigation implementation, arguments, result and errors; only its
      // successful appearance navigation can qualify this observation.
      const navigation = observeAppearanceNavigation({ signal, onTestFinished });
      const entered = owner.native(() => userEvent.keyboard("{Enter}"));
      expect(await navigation.observe(entered)).toEqual({
        to: "/settings/appearance",
        replace: true,
      });
      owner.assertActive();
      // Native command acknowledgement can arrive after the real highlight's
      // unchanged timer expires. Observe from actual navigation completion,
      // while that same Enter is in flight, then require its original result.
      await vi.waitFor(() => {
        expect(document.querySelector("[data-settings-search-input]")).toBeNull();
        expect(effectsRow()?.hasAttribute(SETTINGS_SEARCH_HIGHLIGHT_ATTRIBUTE)).toBe(true);
        expect(document.activeElement?.textContent).toBe("Effects picker");
      });
      owner.assertActive();
      await entered;
      owner.assertActive();
      expect(fixture.navigate).toHaveBeenCalledTimes(1);
    } finally {
      await owner.cleanup();
    }
  });

  it("opens a result with the pointer", async ({ signal, onTestFinished }) => {
    const host = document.createElement("div");
    const owner = ownSettingsSearchMount(host, { signal, onTestFinished }, () => undefined);
    try {
      await owner.mount();
      owner.assertActive();
      await owner.native(() => searchInput().fill("accent"));
      owner.assertActive();
      const navigation = observeAppearanceNavigation({ signal, onTestFinished });
      const clicked = owner.native(() =>
        page.getByRole("option", { name: /Accent color/ }).click(),
      );
      await navigation.observe(clicked);
      owner.assertActive();
      await vi.waitFor(() => {
        expect(fixture.navigate).toHaveBeenCalledWith({
          to: "/settings/appearance",
          replace: true,
        });
        expect(
          document
            .querySelector('[data-settings-search-id="appearance.accentColor"]')
            ?.hasAttribute(SETTINGS_SEARCH_HIGHLIGHT_ATTRIBUTE),
        ).toBe(true);
      });
      owner.assertActive();
      await clicked;
      owner.assertActive();
    } finally {
      await owner.cleanup();
    }
  });

  it("shows the synonym that matched and an empty state", async () => {
    const app = await mount();
    try {
      await searchInput().fill("zoom");
      await vi.waitFor(() => {
        const option = document.querySelector<HTMLElement>('[role="option"]');
        expect(option?.textContent).toContain("Interface size");
        expect(option?.textContent).toContain("zoom");
      });
      await searchInput().fill("qqqq");
      await vi.waitFor(() => {
        expect(document.querySelector('[role="status"]')?.textContent).toBe(
          "No settings match “qqqq”",
        );
      });
      expect(document.querySelector('[role="option"]')).toBeNull();
    } finally {
      await app.cleanup();
    }
  });

  it("clears with Escape, then releases the field without leaving Settings", async () => {
    const app = await mount();
    const escapes: boolean[] = [];
    const recordEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") escapes.push(event.defaultPrevented);
    };
    window.addEventListener("keydown", recordEscape);
    try {
      await searchInput().fill("theme");
      const input = searchInput().element() as HTMLInputElement;
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => {
        expect(input.value).toBe("");
        expect(page.getByRole("button", { name: "Keybindings" }).element()).toBeTruthy();
      });
      expect(document.activeElement).toBe(input);

      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => expect(document.activeElement).not.toBe(input));
      // Both presses were consumed, so the layout's Escape (leave Settings) did not run.
      expect(escapes).toEqual([true, true]);
    } finally {
      window.removeEventListener("keydown", recordEscape);
      await app.cleanup();
    }
  });

  it("focuses and selects the field for a focus request, including one made before mount", async () => {
    useSettingsSearchFocusStore.getState().requestFocus();
    const app = await mount();
    try {
      const input = searchInput().element() as HTMLInputElement;
      await vi.waitFor(() => expect(document.activeElement).toBe(input));

      await searchInput().fill("tabs");
      input.blur();
      useSettingsSearchFocusStore.getState().requestFocus();
      await vi.waitFor(() => {
        expect(document.activeElement).toBe(input);
        expect(input.selectionStart).toBe(0);
        expect(input.selectionEnd).toBe(4);
      });
    } finally {
      await app.cleanup();
    }
  });
});
