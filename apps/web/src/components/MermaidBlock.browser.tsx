import "../index.css";

import type { CDPSession } from "@vitest/browser-playwright";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { cdp, page, userEvent } from "vitest/browser";

import { applyInterfaceScalePercent } from "../interfaceScale";
import {
  createMermaidRenderService,
  renderInMermaidSandbox,
  type MermaidResult,
} from "../lib/mermaid/renderService";
import { MermaidBlock } from "./MermaidBlock";
import { GANTT_SCHEDULE } from "./mermaidGantt.test.fixture";

const mocks = vi.hoisted(() => ({
  render: vi.fn<(source: string, theme: "dark" | "light") => Promise<MermaidResult>>(),
  copy: vi.fn<(source: string) => Promise<void>>(),
}));

vi.mock("../lib/mermaid/renderService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/mermaid/renderService")>()),
  renderMermaid: mocks.render,
}));
vi.mock("../lib/copyToClipboard", () => ({ copyTextToClipboard: mocks.copy }));

const REAL_CHARTS = [
  {
    name: "XY bars",
    label: "Baseline A",
    source: `xychart-beta
    title "Measured totals and forecast"
    x-axis ["Baseline A", "Baseline B", "Forecast", "Target"]
    y-axis "Decimal units" 0 --> 2400
    bar [2262.804, 2174.792, 360, 400]\n`,
  },
  {
    name: "pie showData",
    label: "Header bytes [150]",
    source: `pie showData
    title Resource allocation: exact unit composition
    "Primary pool" : 610698
    "Secondary pool" : 1563944
    "Header bytes" : 150\n`,
  },
  {
    name: "Gantt dependency schedule",
    label: "Final evidence and replay",
    source: GANTT_SCHEDULE,
  },
] as const;

function diagram(title = "Fixture diagram", width = 1200, height = 600): MermaidResult {
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#888"/></svg>`,
    width,
    height,
    title,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

// CDP addresses the runner's top-level viewport. Translate the test frame's
// CSS geometry, including Vitest's display scale, before sending real input.
function browserPoint(point: { x: number; y: number }) {
  let { x, y } = point;
  let frame = window.frameElement;
  while (frame) {
    const element = frame as HTMLElement;
    const rect = element.getBoundingClientRect();
    x = rect.left + (x + element.clientLeft) * (rect.width / element.offsetWidth);
    y = rect.top + (y + element.clientTop) * (rect.height / element.offsetHeight);
    frame = frame.ownerDocument.defaultView?.frameElement ?? null;
  }
  return { x, y };
}

beforeEach(async () => {
  await page.viewport(1100, 800);
  mocks.render.mockReset().mockResolvedValue(diagram());
  mocks.copy.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  applyInterfaceScalePercent(100);
  document.documentElement.classList.remove("dark");
});

describe("Mermaid block", () => {
  it("keeps incomplete source exact and copyable without requesting a render", async ({
    onTestFinished,
  }) => {
    const source = "flowchart LR\n  A[Unfinished  \n";
    const copied = deferred<void>();
    // Own settlement before native input: the production feedback timer must
    // start after the awaited click returns, not while its provider round trip
    // can still hide the entire transient label from this fixture's observer.
    let retired = false;
    let screen: Awaited<ReturnType<typeof render>> | undefined;
    let pendingRender: ReturnType<typeof render> | undefined;
    let cleanupPromise: Promise<void> | undefined;
    const requireActive = () => {
      if (retired) throw new Error("Mermaid copy fixture already retired");
    };
    const cleanup = () => {
      if (cleanupPromise) return cleanupPromise;
      retired = true;
      cleanupPromise = (async () => {
        try {
          // The pinned renderer's automatic cleanup runs before the next test,
          // not before this completion hook. Join our exact pending render and
          // retire its component before releasing an abandoned clipboard call.
          const ownedScreen = screen ?? (await pendingRender);
          await ownedScreen?.unmount();
        } finally {
          // Release on rejected render/unmount as well. Promise settlement is
          // idempotent, so finally and the completion hook share one cleanup.
          copied.resolve(undefined);
        }
      })();
      return cleanupPromise;
    };
    // Install ownership before render can yield. A hard deadline can settle the
    // test without unwinding its async body; late work must join this cleanup.
    onTestFinished(cleanup);
    mocks.copy.mockReturnValueOnce(copied.promise);
    try {
      pendingRender = render(<MermaidBlock code={source} complete={false} theme="dark" />);
      screen = await pendingRender;
      requireActive();
      expect(document.querySelector(".mermaid-source code")?.textContent).toBe(source);
      expect(mocks.render).not.toHaveBeenCalled();
      await expect
        .element(page.getByRole("button", { name: "Diagram", exact: true }))
        .toBeDisabled();
      requireActive();
      await page.getByRole("button", { name: "Copy Mermaid source" }).click();
      requireActive();
      expect(mocks.copy).toHaveBeenCalledExactlyOnceWith(source);
      expect(page.getByText("Copied", { exact: true }).query()).toBeNull();
      copied.resolve(undefined);
      await expect.element(page.getByText("Copied", { exact: true })).toBeVisible();
      requireActive();
      await screen.rerender(<MermaidBlock code={source + "]"} complete theme="dark" />);
      requireActive();
      await expect.element(page.getByRole("img", { name: "Fixture diagram" })).toBeVisible();
      requireActive();
    } finally {
      await cleanup();
    }
  });

  it("shows a fixed failure notice and retains unsupported or invalid source", async () => {
    const source = "unsupported-secret-diagram\nprivate-source";
    mocks.render.mockRejectedValue(new Error("private-exception /secret/path"));
    const screen = await render(<MermaidBlock code={source} complete theme="light" />);
    try {
      await expect
        .element(page.getByText("Couldn't render this diagram. Showing its source."))
        .toBeVisible();
      expect(document.querySelector(".mermaid-source code")?.textContent).toBe(source);
      expect(document.body.textContent).not.toContain("private-exception");
      expect(document.body.textContent).not.toContain("/secret/path");
      await expect.element(page.getByRole("button", { name: "Expand diagram" })).toBeDisabled();
      await page.getByRole("button", { name: "Copy Mermaid source" }).click();
      expect(mocks.copy).toHaveBeenCalledExactlyOnceWith(source);
    } finally {
      await screen.unmount();
    }
  });

  it("ignores stale source and theme responses and revokes each owned image URL", async () => {
    const first = deferred<MermaidResult>();
    const second = deferred<MermaidResult>();
    const createUrl = vi.spyOn(URL, "createObjectURL");
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL");
    mocks.render.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const screen = await render(<MermaidBlock code="first" complete theme="dark" />);
    try {
      await screen.rerender(<MermaidBlock code="second" complete theme="light" />);
      second.resolve(diagram("Current diagram"));
      await expect.element(page.getByRole("img", { name: "Current diagram" })).toBeVisible();
      const currentUrl = document.querySelector<HTMLImageElement>(".mermaid-preview img")!.src;
      first.resolve(diagram("Stale diagram"));
      await Promise.resolve();
      await Promise.resolve();
      expect(createUrl).toHaveBeenCalledTimes(1);
      expect(document.querySelector<HTMLImageElement>(".mermaid-preview img")!.alt).toBe(
        "Current diagram",
      );
      expect(mocks.render).toHaveBeenNthCalledWith(1, "first", "dark");
      expect(mocks.render).toHaveBeenNthCalledWith(2, "second", "light");
      await screen.rerender(<MermaidBlock code="second" complete theme="dark" />);
      await expect.element(page.getByRole("img", { name: "Fixture diagram" })).toBeVisible();
      expect(revokeUrl).toHaveBeenCalledWith(currentUrl);
    } finally {
      await screen.unmount();
    }
    expect(revokeUrl).toHaveBeenCalledTimes(2);
  });

  it("does not allocate an image or clipboard feedback after unmount", async () => {
    const pending = deferred<MermaidResult>();
    const copied = deferred<void>();
    const createUrl = vi.spyOn(URL, "createObjectURL");
    mocks.render.mockReturnValue(pending.promise);
    mocks.copy.mockReturnValue(copied.promise);
    const screen = await render(<MermaidBlock code="flowchart LR\nA-->B" complete theme="dark" />);
    await page.getByRole("button", { name: "Copy Mermaid source" }).click();
    await screen.unmount();
    pending.resolve(diagram());
    copied.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(createUrl).not.toHaveBeenCalled();
    expect(document.querySelector(".mermaid-block")).toBeNull();
  });

  it("exposes selectable source after a clipboard failure without losing the diagram toggle", async () => {
    mocks.copy.mockRejectedValue(new Error("private clipboard detail"));
    const source = "flowchart LR\nA-->B";
    const screen = await render(<MermaidBlock code={source} complete theme="light" />);
    try {
      await expect.element(page.getByRole("img", { name: "Fixture diagram" })).toBeVisible();
      await page.getByRole("button", { name: "Copy Mermaid source" }).click();
      await expect
        .element(page.getByRole("button", { name: "Source", exact: true }))
        .toHaveAttribute("aria-pressed", "true");
      expect(document.querySelector(".mermaid-source code")?.textContent).toBe(source);
      expect(document.body.textContent).not.toContain("private clipboard detail");
      await page.getByRole("button", { name: "Diagram", exact: true }).click();
      await expect.element(page.getByRole("img", { name: "Fixture diagram" })).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("does not reuse a revoked image when a pending replacement changes back to its prior source", async () => {
    const replacement = deferred<MermaidResult>();
    const repeated = deferred<MermaidResult>();
    mocks.render
      .mockResolvedValueOnce(diagram("Original diagram"))
      .mockReturnValueOnce(replacement.promise)
      .mockReturnValueOnce(repeated.promise);
    const screen = await render(<MermaidBlock code="original" complete theme="dark" />);
    try {
      await expect.element(page.getByRole("img", { name: "Original diagram" })).toBeVisible();
      await screen.rerender(<MermaidBlock code="replacement" complete theme="dark" />);
      await screen.rerender(<MermaidBlock code="original" complete theme="dark" />);
      expect(document.querySelector(".mermaid-preview img")).toBeNull();
      repeated.resolve(diagram("Restored diagram"));
      await expect.element(page.getByRole("img", { name: "Restored diagram" })).toBeVisible();
      replacement.reject(new Error("obsolete failure"));
      await Promise.resolve();
      await Promise.resolve();
      await expect.element(page.getByRole("img", { name: "Restored diagram" })).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it.each([
    { theme: "light" as const, scale: 80 },
    { theme: "light" as const, scale: 130 },
    { theme: "dark" as const, scale: 80 },
    { theme: "dark" as const, scale: 130 },
  ])("contains diagram and source overflow at $theme/$scale%", async ({ theme, scale }) => {
    await page.viewport(390, 700);
    applyInterfaceScalePercent(scale);
    document.documentElement.classList.toggle("dark", theme === "dark");
    const host = document.createElement("div");
    host.className = "chat-markdown";
    host.style.width = "min(100%, 19rem)";
    document.body.append(host);
    const source = `flowchart LR\nA[${"wide".repeat(300)}]-->B`;
    mocks.render.mockResolvedValue(diagram("Wide diagram", 12000, 6000));
    const screen = await render(<MermaidBlock code={source} complete theme={theme} />, {
      container: host,
    });
    try {
      await expect.element(page.getByRole("img", { name: "Wide diagram" })).toBeVisible();
      const block = host.querySelector<HTMLElement>(".mermaid-block")!;
      expect(block.getBoundingClientRect().width).toBeLessThanOrEqual(
        host.getBoundingClientRect().width + 1,
      );
      expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
      const image = host.querySelector<HTMLImageElement>("img")!;
      const preview = host.querySelector<HTMLElement>(".mermaid-preview")!;
      expect(image.getBoundingClientRect().width).toBe(image.naturalWidth);
      expect(preview.scrollWidth).toBeGreaterThan(preview.clientWidth);
      expect(preview.scrollHeight).toBeGreaterThan(preview.clientHeight);
      expect(preview.getBoundingClientRect().right).toBeLessThanOrEqual(
        block.getBoundingClientRect().right,
      );
      await page.getByRole("button", { name: "Source", exact: true }).click();
      const sourceBlock = host.querySelector<HTMLElement>(".mermaid-source")!;
      expect(sourceBlock.scrollWidth).toBeGreaterThan(sourceBlock.clientWidth);
      expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
      expect(sourceBlock.textContent).toBe(source);
      await page.getByRole("button", { name: "Diagram", exact: true }).click();
      await page.getByRole("button", { name: "Expand diagram" }).click();
      await expect
        .element(page.getByRole("dialog", { name: "Expanded Mermaid diagram" }))
        .toBeVisible();
      const popup = document.querySelector<HTMLElement>(".mermaid-expanded-dialog")!;
      expect(popup.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth + 1);
      expect(popup.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight + 1);
      await userEvent.keyboard("{Escape}");
      await expect.element(page.getByRole("button", { name: "Expand diagram" })).toHaveFocus();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("expands with fit, zoom, native scroll and pointer pan, then restores trigger focus", async ({
    onTestFinished,
  }) => {
    let observedViewport: HTMLElement | null = null;
    let observingArrow = false;
    let retired = false;
    let sequence = 0;
    const started = performance.now();
    const finite = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) ? value : null;
    const readKeyboardViewport = (
      phase: string,
      extra: Record<string, string | number | boolean | null> = {},
    ) => {
      const base = {
        sequence: ++sequence,
        phase,
        elapsedMs: performance.now() - started,
        ...extra,
      };
      try {
        const viewport = observedViewport;
        const imageBounds = viewport?.querySelector("img")?.getBoundingClientRect();
        const frame = window.frameElement;
        return {
          ...base,
          documentFocused: document.hasFocus(),
          visibility: document.visibilityState === "visible" ? "visible" : "hidden",
          activeViewport: document.activeElement === viewport,
          parentDocumentFocused: frame ? frame.ownerDocument.hasFocus() : null,
          parentActiveFrame: frame ? frame.ownerDocument.activeElement === frame : null,
          connected: viewport?.isConnected === true,
          inert: viewport ? viewport.closest("[inert]") !== null : null,
          scrollLeft: finite(viewport?.scrollLeft),
          scrollTop: finite(viewport?.scrollTop),
          scrollWidth: finite(viewport?.scrollWidth),
          scrollHeight: finite(viewport?.scrollHeight),
          clientWidth: finite(viewport?.clientWidth),
          clientHeight: finite(viewport?.clientHeight),
          imageWidth: finite(imageBounds?.width),
          imageHeight: finite(imageBounds?.height),
        };
      } catch {
        return { ...base, receiptUnavailable: true };
      }
    };
    type KeyboardViewportReceipt = ReturnType<typeof readKeyboardViewport>;
    let baseline: KeyboardViewportReceipt | null = null;
    const events: KeyboardViewportReceipt[] = [];
    const recordKeyboardViewport = (
      phase: string,
      extra: Record<string, string | number | boolean | null> = {},
    ) => {
      if (!observingArrow || retired) return;
      events.push(readKeyboardViewport(phase, extra));
      if (events.length > 16) events.shift();
    };
    const observeKeyboard = (event: KeyboardEvent) => {
      if (event.key !== "ArrowRight" || !observingArrow || retired) return;
      const fields = () => ({
        trusted: event.isTrusted,
        exactTarget: event.target === observedViewport,
        defaultPrevented: event.defaultPrevented,
        code: event.code === "ArrowRight" ? "ArrowRight" : "other",
        keyCode: finite(event.keyCode),
        location: finite(event.location),
        ctrl: event.ctrlKey,
        meta: event.metaKey,
        alt: event.altKey,
        shift: event.shiftKey,
        repeat: event.repeat,
        composing: event.isComposing,
      });
      recordKeyboardViewport(
        event.type === "keydown" ? "keydown-capture" : "keyup-capture",
        fields(),
      );
      // Default prevention and focus can change during dispatch. Observe the
      // settled event without preventing input, retaining text, or replaying it.
      queueMicrotask(() => {
        if (retired) return;
        recordKeyboardViewport(
          event.type === "keydown" ? "keydown-final" : "keyup-final",
          fields(),
        );
      });
    };
    const observeNativeFocus = (event: FocusEvent) => {
      recordKeyboardViewport(event.type === "focus" ? "native-focus" : "native-blur", {
        trusted: event.isTrusted,
        exactTarget: event.target === observedViewport,
        windowTarget: event.target === window,
      });
    };
    const observeNativeScroll = (event: Event) => {
      if (event.target !== observedViewport) return;
      recordKeyboardViewport(event.type === "scroll" ? "native-scroll" : "native-scrollend", {
        trusted: event.isTrusted,
      });
    };
    const retireKeyboardDiagnostic = () => {
      if (retired) return;
      retired = true;
      observingArrow = false;
      window.removeEventListener("keydown", observeKeyboard, true);
      window.removeEventListener("keyup", observeKeyboard, true);
      window.removeEventListener("focus", observeNativeFocus, true);
      window.removeEventListener("blur", observeNativeFocus, true);
      observedViewport?.removeEventListener("scroll", observeNativeScroll);
      observedViewport?.removeEventListener("scrollend", observeNativeScroll);
      // One bounded source-free receipt on both ordinary and hard-timeout
      // retirement. Late microtasks cannot publish into a later test's realm.
      console.info(
        "mermaid-keyboard-pan-diagnostic",
        JSON.stringify({
          baseline,
          events,
          final: readKeyboardViewport("final"),
        }),
      );
    };
    onTestFinished(retireKeyboardDiagnostic);
    window.addEventListener("keydown", observeKeyboard, true);
    window.addEventListener("keyup", observeKeyboard, true);
    window.addEventListener("focus", observeNativeFocus, true);
    window.addEventListener("blur", observeNativeFocus, true);
    mocks.render.mockResolvedValue(diagram("Large diagram", 3000, 1600));
    const screen = await render(<MermaidBlock code="flowchart LR\nA-->B" complete theme="dark" />);
    try {
      await expect.element(page.getByRole("img", { name: "Large diagram" })).toBeVisible();
      await page.getByRole("button", { name: "Expand diagram" }).click();
      await expect
        .element(page.getByRole("dialog", { name: "Expanded Mermaid diagram" }))
        .toBeVisible();
      const viewport = document.querySelector<HTMLElement>(".mermaid-expanded-viewport")!;
      // Completion may retire observations while render/input is still pending;
      // a resumed body must not attach listeners after that one-shot cleanup.
      if (retired) return;
      observedViewport = viewport;
      viewport.addEventListener("scroll", observeNativeScroll);
      viewport.addEventListener("scrollend", observeNativeScroll);
      await vi.waitFor(() => {
        expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth + 1);
        expect(viewport.scrollHeight).toBeLessThanOrEqual(viewport.clientHeight + 1);
      });
      await page.getByRole("button", { name: "Reset", exact: true }).click();
      expect(document.querySelector(".mermaid-zoom-value")?.textContent).toBe("100%");
      expect(viewport.scrollWidth).toBeGreaterThan(viewport.clientWidth);
      await page.getByRole("button", { name: "Zoom in", exact: true }).click();
      expect(document.querySelector(".mermaid-zoom-value")?.textContent).toBe("125%");
      await page.getByRole("button", { name: "Zoom out", exact: true }).click();
      // Use ordinary native pointer activation as well as DOM focus, while
      // retaining the single key action and the original scrolling assertion.
      await page.getByRole("region", { name: "Expanded diagram; scroll or drag to pan" }).click();
      if (retired) throw new Error("Mermaid keyboard fixture already retired");
      await vi.waitFor(() => {
        expect(document.activeElement).toBe(viewport);
        expect(viewport.hasAttribute("data-dragging")).toBe(false);
      });
      if (retired) throw new Error("Mermaid keyboard fixture already retired");
      observingArrow = true;
      baseline = readKeyboardViewport("baseline");
      await userEvent.keyboard("{ArrowRight}");
      recordKeyboardViewport("after-key-command");
      await vi.waitFor(() => expect(viewport.scrollLeft).toBeGreaterThan(0));
      recordKeyboardViewport("arrow-observed");
      observingArrow = false;
      viewport.scrollTo(100, 100);
      const rect = viewport.getBoundingClientRect();
      const start = browserPoint({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      const end = browserPoint({
        x: rect.left + rect.width / 2 - 70,
        y: rect.top + rect.height / 2 - 50,
      });
      const input: CDPSession = cdp();
      await input.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...start });
      await input.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...start,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      try {
        await input.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          ...end,
          button: "left",
          buttons: 1,
        });
        await vi.waitFor(() => {
          expect(viewport.scrollLeft).toBeGreaterThan(150);
          expect(viewport.scrollTop).toBeGreaterThan(130);
        });
      } finally {
        await input.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          ...end,
          button: "left",
          buttons: 0,
          clickCount: 1,
        });
      }
      await page.getByRole("button", { name: "Fit", exact: true }).click();
      await vi.waitFor(() =>
        expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth + 1),
      );
      expect(viewport.scrollLeft).toBe(0);
      await userEvent.keyboard("{Escape}");
      await expect.element(page.getByRole("button", { name: "Expand diagram" })).toHaveFocus();
    } finally {
      retireKeyboardDiagnostic();
      await screen.unmount();
    }
  });

  it.for(REAL_CHARTS.map((chart) => ({ ...chart, theme: "dark" as const, scale: 100 })))(
    "retains real $name source, copy and expanded controls",
    async ({ source, label, theme, scale }, { onTestFinished }) => {
      let retired = false;
      let ownedHost: HTMLDivElement | undefined;
      let screen: Awaited<ReturnType<typeof render>> | undefined;
      let pendingRender: ReturnType<typeof render> | undefined;
      let cleanupPromise: Promise<void> | undefined;
      let retireKeyboardObservation: (() => void) | undefined;
      const requireActive = () => {
        if (retired) throw new Error("Mermaid chart fixture already retired");
      };
      const cleanup = () => {
        if (cleanupPromise) return cleanupPromise;
        retired = true;
        retireKeyboardObservation?.();
        cleanupPromise = (async () => {
          try {
            // Join only this invocation's admitted render before unmounting.
            // A hard deadline need not unwind the suspended async test body.
            const ownedScreen = screen ?? (await pendingRender);
            await ownedScreen?.unmount();
          } finally {
            ownedHost?.remove();
          }
        })();
        return cleanupPromise;
      };
      // Capture this test's context and cleanup before the first yield. Late
      // continuations must not register against a later test's global context.
      onTestFinished(cleanup);
      await page.viewport(390, 700);
      requireActive();
      applyInterfaceScalePercent(scale);
      document.documentElement.classList.toggle("dark", theme === "dark");
      const host = document.createElement("div");
      ownedHost = host;
      host.className = "chat-markdown";
      host.style.width = "min(100%, 19rem)";
      document.body.append(host);
      // Retain the existing lifecycle test double, but give chart cases a
      // fresh real service and its ordinary opaque-origin sandbox. This also
      // exercises parent admission and sanitized image publication; Mermaid
      // itself is never evaluated in this test document's application realm.
      mocks.render.mockImplementation(createMermaidRenderService(renderInMermaidSandbox));
      try {
        requireActive();
        pendingRender = render(<MermaidBlock code={source} complete theme={theme} />, {
          container: host,
        });
        screen = await pendingRender;
        requireActive();
        // Keep the established 30-second browser test deadline. As in the real
        // preview harness, bound cold bundle/sandbox readiness separately from
        // the remaining source, geometry and native-input checks.
        await vi.waitFor(() => expect(host.querySelector(".mermaid-preview img")).not.toBeNull(), {
          timeout: 20_000,
        });
        requireActive();
        const image = host.querySelector<HTMLImageElement>(".mermaid-preview img")!;
        await image.decode();
        requireActive();
        expect(image.naturalWidth).toBeGreaterThan(0);
        expect(image.naturalHeight).toBeGreaterThan(0);
        const imageUrl = image.src;
        const response = await fetch(imageUrl);
        requireActive();
        const svg = await response.text();
        requireActive();
        const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
        expect(parsed.querySelector("foreignObject,script,image,a,use")).toBeNull();
        for (const style of parsed.querySelectorAll("style")) style.remove();
        expect(parsed.documentElement.textContent).toContain(label);
        expect(mocks.render).toHaveBeenCalledExactlyOnceWith(source, theme);
        expect(document.querySelector('iframe[title="Isolated diagram renderer"]')).toBeNull();

        const block = host.querySelector<HTMLElement>(".mermaid-block")!;
        const preview = host.querySelector<HTMLElement>(".mermaid-preview")!;
        expect(block.getBoundingClientRect().width).toBeLessThanOrEqual(
          host.getBoundingClientRect().width + 1,
        );
        expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
        expect(image.getBoundingClientRect().width).toBeCloseTo(image.naturalWidth, 0);
        expect(preview.scrollWidth).toBeGreaterThan(preview.clientWidth);
        await expect
          .element(page.getByRole("button", { name: "Diagram", exact: true }))
          .toHaveAttribute("aria-pressed", "true");
        requireActive();
        await page.getByRole("button", { name: "Source", exact: true }).click();
        requireActive();
        expect(host.querySelector(".mermaid-source code")?.textContent).toBe(source);
        expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
        await page.getByRole("button", { name: "Copy Mermaid source" }).click();
        requireActive();
        expect(mocks.copy).toHaveBeenCalledExactlyOnceWith(source);
        await expect.element(page.getByText("Copied", { exact: true })).toBeVisible();
        requireActive();
        await page.getByRole("button", { name: "Diagram", exact: true }).click();
        requireActive();
        expect(host.querySelector<HTMLImageElement>(".mermaid-preview img")!.src).toBe(imageUrl);

        await page.getByRole("button", { name: "Expand diagram" }).click();
        requireActive();
        await expect
          .element(page.getByRole("dialog", { name: "Expanded Mermaid diagram" }))
          .toBeVisible();
        requireActive();
        const popup = document.querySelector<HTMLElement>(".mermaid-expanded-dialog")!;
        const viewport = document.querySelector<HTMLElement>(".mermaid-expanded-viewport")!;
        await vi.waitFor(() => {
          expect(Number(getComputedStyle(popup).opacity)).toBe(1);
          expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth + 1);
          expect(viewport.scrollHeight).toBeLessThanOrEqual(viewport.clientHeight + 1);
        });
        requireActive();
        expect(popup.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth + 1);
        expect(popup.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight + 1);
        await page.getByRole("button", { name: "Reset", exact: true }).click();
        requireActive();
        expect(document.querySelector(".mermaid-zoom-value")?.textContent).toBe("100%");
        expect(viewport.scrollWidth).toBeGreaterThan(viewport.clientWidth);
        await page.getByRole("button", { name: "Zoom in", exact: true }).click();
        requireActive();
        expect(document.querySelector(".mermaid-zoom-value")?.textContent).toBe("125%");
        await page.getByRole("button", { name: "Zoom out", exact: true }).click();
        requireActive();
        expect(document.querySelector(".mermaid-zoom-value")?.textContent).toBe("100%");
        // Real chart families are smaller than the large rectangle used
        // by the existing control fixture. Two zoom steps ensure scroll room
        // on both axes before exercising keyboard input and pointer capture.
        await page.getByRole("button", { name: "Zoom in", exact: true }).click();
        requireActive();
        await page.getByRole("button", { name: "Zoom in", exact: true }).click();
        requireActive();
        // The zoom controls and dialog can still be committing content/focus
        // after a provider-owned click returns. Observe the actual scroll
        // target before the original single key; do not replay input or repair
        // native scroll if the positive fails. This is a prerequisite check,
        // not a claim about an earlier failure's unobserved cause.
        let keyboardRetired = false;
        let keyboardSucceeded = false;
        const keyboardObservations: Array<Record<string, string | number | boolean>> = [];
        const readKeyboardViewport = (phase: string) => ({
          phase,
          documentFocused: document.hasFocus(),
          visible: document.visibilityState === "visible",
          activeViewport: document.activeElement === viewport,
          connected: viewport.isConnected,
          inert: viewport.closest("[inert]") !== null,
          scrollLeft: viewport.scrollLeft,
          scrollTop: viewport.scrollTop,
          scrollWidth: viewport.scrollWidth,
          scrollHeight: viewport.scrollHeight,
          clientWidth: viewport.clientWidth,
          clientHeight: viewport.clientHeight,
        });
        const recordKeyboard = (event: KeyboardEvent) => {
          if (keyboardRetired || event.key !== "ArrowRight" || keyboardObservations.length >= 16)
            return;
          const fields = () => ({
            ...readKeyboardViewport(event.type),
            trusted: event.isTrusted,
            exactTarget: event.target === viewport,
            defaultPrevented: event.defaultPrevented,
            ctrl: event.ctrlKey,
            meta: event.metaKey,
            alt: event.altKey,
            shift: event.shiftKey,
          });
          keyboardObservations.push(fields());
          queueMicrotask(() => {
            if (!keyboardRetired && keyboardObservations.length < 16)
              keyboardObservations.push({ ...fields(), phase: `${event.type}-settled` });
          });
        };
        const recordKeyboardFocus = (event: FocusEvent) => {
          if (
            !keyboardRetired &&
            keyboardObservations.length < 16 &&
            (event.target === viewport || event.target === window)
          )
            keyboardObservations.push(readKeyboardViewport(event.type));
        };
        retireKeyboardObservation = () => {
          if (keyboardRetired) return;
          keyboardRetired = true;
          window.removeEventListener("keydown", recordKeyboard, true);
          window.removeEventListener("keyup", recordKeyboard, true);
          window.removeEventListener("focus", recordKeyboardFocus, true);
          window.removeEventListener("blur", recordKeyboardFocus, true);
          // Fixed, source-free and failure-only. Completion owns retirement
          // even if the enclosing test reaches its original hard deadline.
          if (!keyboardSucceeded)
            console.info("mermaid-chart-keyboard-readiness", {
              observations: keyboardObservations,
              final: readKeyboardViewport("final"),
            });
        };
        requireActive();
        window.addEventListener("keydown", recordKeyboard, true);
        window.addEventListener("keyup", recordKeyboard, true);
        window.addEventListener("focus", recordKeyboardFocus, true);
        window.addEventListener("blur", recordKeyboardFocus, true);
        try {
          await page
            .getByRole("region", { name: "Expanded diagram; scroll or drag to pan" })
            .click();
          requireActive();
          await vi.waitFor(() => {
            expect(document.hasFocus()).toBe(true);
            expect(document.activeElement).toBe(viewport);
            expect(viewport.hasAttribute("data-dragging")).toBe(false);
            expect(viewport.scrollWidth).toBeGreaterThan(viewport.clientWidth);
            expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
          });
          requireActive();
          if (keyboardRetired) throw new Error("Mermaid keyboard fixture already retired");
          keyboardObservations.push(readKeyboardViewport("ready"));
          await userEvent.keyboard("{ArrowRight}");
          requireActive();
          if (keyboardRetired) throw new Error("Mermaid keyboard fixture already retired");
          await vi.waitFor(() => expect(viewport.scrollLeft).toBeGreaterThan(0));
          requireActive();
          if (keyboardRetired) throw new Error("Mermaid keyboard fixture already retired");
          keyboardSucceeded = true;
        } finally {
          retireKeyboardObservation();
        }
        viewport.scrollTo(50, 50);
        const rect = viewport.getBoundingClientRect();
        const start = browserPoint({
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        });
        const end = browserPoint({
          x: rect.left + rect.width / 2 - 50,
          y: rect.top + rect.height / 2 - 30,
        });
        const input: CDPSession = cdp();
        await input.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...start });
        requireActive();
        await input.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          ...start,
          button: "left",
          buttons: 1,
          clickCount: 1,
        });
        try {
          // Keep the original release in finally if the admitted press returns
          // only after this invocation's completion has retired it.
          requireActive();
          await input.send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            ...end,
            button: "left",
            buttons: 1,
          });
          requireActive();
          await vi.waitFor(() => {
            expect(viewport.scrollLeft).toBeGreaterThan(80);
            expect(viewport.scrollTop).toBeGreaterThan(65);
          });
          requireActive();
        } finally {
          await input.send("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            ...end,
            button: "left",
            buttons: 0,
            clickCount: 1,
          });
        }
        requireActive();
        await page.getByRole("button", { name: "Fit", exact: true }).click();
        requireActive();
        await vi.waitFor(() => {
          expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth + 1);
          expect(viewport.scrollHeight).toBeLessThanOrEqual(viewport.clientHeight + 1);
        });
        requireActive();
        expect(viewport.scrollLeft).toBe(0);
        expect(viewport.scrollTop).toBe(0);
        await userEvent.keyboard("{Escape}");
        requireActive();
        await expect.element(page.getByRole("button", { name: "Expand diagram" })).toHaveFocus();
        requireActive();
      } finally {
        await cleanup();
      }
    },
  );
});
