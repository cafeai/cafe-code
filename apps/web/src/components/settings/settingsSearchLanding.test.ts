import { expect, it, vi, type TestContext } from "vitest";
import {
  clearSettingsSearchHighlight,
  revealSettingsSearchTarget,
  SETTINGS_SEARCH_HIGHLIGHT_ATTRIBUTE,
} from "./settingsSearchLanding";

/**
 * A typed structural DOM boundary for the actual reveal controller. Native
 * geometry/focus remain browser qualification; this fixture owns only inert
 * anchors, listener cleanup and the exact requested frame callbacks.
 */
function fixture(context: TestContext, reducedMotion = false) {
  let retired = false;
  let globalsReady = false;
  let timersOwned = false;
  let globalsOwned = false;
  let cleanupPromise: Promise<void> | undefined;
  let nextFrameId = 0;
  const pending = new Set<Promise<unknown>>();
  const frames = new Map<number, FrameRequestCallback>();
  const capturedFrames = new Map<number, FrameRequestCallback>();
  const requested: number[] = [];
  const waiters: { resolve: (id: number) => void; reject: (error: Error) => void }[] = [];
  const anchors = new Map<string, HTMLElement>();
  const root = {
    querySelector: vi.fn((selector: string): HTMLElement | null => anchors.get(selector) ?? null),
  };
  // Only this query method is consumed by the actual controller.
  const rootElement = root as unknown as HTMLElement;
  const window = Object.assign(new EventTarget(), {
    matchMedia: vi.fn((_query: string): Pick<MediaQueryList, "matches"> => ({
      matches: reducedMotion,
    })),
  });
  const requireActive = () => {
    if (retired) throw new Error("Synthetic Settings reveal fixture retired");
  };
  const own = <T>(operation: () => Promise<T>): Promise<T> => {
    requireActive();
    const result = operation();
    pending.add(result);
    void result.then(
      () => pending.delete(result),
      () => pending.delete(result),
    );
    return result;
  };
  const requestFrame = vi.fn((callback: FrameRequestCallback): number => {
    requireActive();
    if (nextFrameId >= 8) throw new Error("Synthetic Settings reveal frame bound exceeded");
    const id = ++nextFrameId;
    frames.set(id, callback);
    capturedFrames.set(id, callback);
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(id);
    else requested.push(id);
    return id;
  });
  const retire = () => {
    retired = true;
  };
  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    retire();
    cleanupPromise = (async () => {
      try {
        if (globalsReady) {
          // A real page reveal supersedes activeReveal without needing an
          // anchor or another RAF. Drain only this fixture's captured callbacks
          // so an old aborted reveal cannot escape into the next case.
          await revealSettingsSearchTarget({ id: "cleanup", kind: "page", root: rootElement });
          for (const waiter of waiters.splice(0))
            waiter.reject(new Error("Synthetic Settings reveal fixture retired"));
          requested.length = 0;
          for (const [id, callback] of [...frames]) {
            frames.delete(id);
            capturedFrames.delete(id);
            callback(0);
          }
          await Promise.allSettled([...pending]);
        }
      } finally {
        try {
          // The real cleanup still needs its original window/listener and fake
          // timer owners. Restore globals only after that cleanup has finished.
          if (globalsReady) clearSettingsSearchHighlight();
        } finally {
          capturedFrames.clear();
          if (timersOwned) {
            vi.clearAllTimers();
            vi.useRealTimers();
          }
          if (globalsOwned) vi.unstubAllGlobals();
          context.signal.removeEventListener("abort", retire);
        }
      }
    })();
    return cleanupPromise;
  };
  context.onTestFinished(cleanup);
  context.signal.addEventListener("abort", retire, { once: true });
  if (context.signal.aborted) retire();
  requireActive();
  vi.useFakeTimers();
  timersOwned = true;
  vi.stubGlobal("window", window);
  globalsOwned = true;
  // IDs in this fixture are inert literals; CSS escaping is not under test.
  vi.stubGlobal("CSS", { escape: (id: string) => id });
  vi.stubGlobal("requestAnimationFrame", requestFrame);
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
    const index = requested.indexOf(id);
    if (index !== -1) requested.splice(index, 1);
  });
  globalsReady = true;

  return {
    root,
    window,
    own,
    requestFrame,
    cleanup,
    anchor(id: string, withControl = true) {
      requireActive();
      const order: string[] = [];
      const attributes = new Map<string, string>();
      const control = {
        focus: vi.fn((_options?: FocusOptions) => {
          order.push("focus");
        }),
      };
      const controlElement = control as unknown as HTMLElement;
      const node = Object.assign(new EventTarget(), {
        isConnected: true,
        dataset: { settingsSearchTarget: "row" },
        scrollIntoView: vi.fn((_options?: boolean | ScrollIntoViewOptions) => {
          order.push("scroll");
        }),
        setAttribute(name: string, value: string) {
          attributes.set(name, value);
          if (name === SETTINGS_SEARCH_HIGHLIGHT_ATTRIBUTE) order.push("highlight");
        },
        removeAttribute(name: string) {
          attributes.delete(name);
        },
        querySelector: vi.fn((_selector: string): HTMLElement | null =>
          withControl ? controlElement : null,
        ),
        querySelectorAll: vi.fn((_selector: string): HTMLElement[] => []),
      });
      // All runtime members consumed by the reveal API are defined above; no
      // real document, user profile or native browser is attached to this cast.
      const element = node as unknown as HTMLElement;
      anchors.set(`[data-settings-search-id="${id}"]`, element);
      return {
        node,
        control,
        order,
        highlighted: () => attributes.has(SETTINGS_SEARCH_HIGHLIGHT_ATTRIBUTE),
      };
    },
    nextFrame: () =>
      own(
        () =>
          new Promise<number>((resolve, reject) => {
            const id = requested.shift();
            if (id !== undefined) resolve(id);
            else waiters.push({ resolve, reject });
          }),
      ),
    flushFrame(id: number) {
      requireActive();
      // Retain the exact captured callback even if cancellation removed the
      // queued frame: the supersession negative deliberately delivers it late.
      const callback = capturedFrames.get(id);
      if (!callback) throw new Error("Synthetic Settings reveal frame is not owned");
      capturedFrames.delete(id);
      frames.delete(id);
      callback(0);
    },
    reveal: (id: string, kind: "page" | "setting" = "setting", isCurrent?: () => boolean) =>
      own(() =>
        revealSettingsSearchTarget({
          id,
          kind,
          root: rootElement,
          ...(isCurrent ? { isCurrent } : {}),
        }),
      ),
  };
}

async function withFixture(
  context: TestContext,
  reducedMotion: boolean,
  run: (value: ReturnType<typeof fixture>) => Promise<void>,
) {
  const value = fixture(context, reducedMotion);
  try {
    await run(value);
  } finally {
    await value.cleanup();
  }
}

for (const reducedMotion of [false, true])
  it(`reveals in scroll/highlight/focus order with instant positioning (reduced=${reducedMotion})`, async (context) => {
    await withFixture(context, reducedMotion, async (f) => {
      const anchor = f.anchor("one");
      // Install the exact frame receipt before the actual API can request it.
      const frame = f.nextFrame();
      const reveal = f.reveal("one");
      const result = f.own(() =>
        reveal.then((value) => {
          anchor.order.push("resolved");
          return value;
        }),
      );
      const id = await frame;
      expect(anchor.order).toEqual([]);
      f.flushFrame(id);
      await expect(result).resolves.toBe(true);
      expect(anchor.node.scrollIntoView).toHaveBeenCalledExactlyOnceWith({
        block: "center",
        behavior: "instant",
      });
      expect(anchor.control.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
      expect(anchor.order).toEqual(["scroll", "highlight", "focus", "resolved"]);
      expect(anchor.highlighted()).toBe(true);
      clearSettingsSearchHighlight();
      expect(anchor.highlighted()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

it("does not reveal a superseded anchor when its captured frame arrives later", async (context) => {
  await withFixture(context, false, async (f) => {
    const first = f.anchor("one");
    const second = f.anchor("two");
    const firstFrame = f.nextFrame();
    const oldReveal = f.reveal("one");
    const oldId = await firstFrame;
    const secondFrame = f.nextFrame();
    const newReveal = f.reveal("two");
    const newId = await secondFrame;
    f.flushFrame(oldId);
    await expect(oldReveal).resolves.toBe(false);
    expect(first.order).toEqual([]);
    expect(first.highlighted()).toBe(false);
    f.flushFrame(newId);
    await expect(newReveal).resolves.toBe(true);
    expect(second.order).toEqual(["scroll", "highlight", "focus"]);
    expect(second.highlighted()).toBe(true);
  });
});

it("does not scroll, highlight or focus an anchor disconnected before its frame", async (context) => {
  await withFixture(context, false, async (f) => {
    const anchor = f.anchor("one");
    const frame = f.nextFrame();
    const reveal = f.reveal("one");
    const id = await frame;
    anchor.node.isConnected = false;
    f.flushFrame(id);
    await expect(reveal).resolves.toBe(false);
    expect(anchor.order).toEqual([]);
    expect(anchor.highlighted()).toBe(false);
  });
});

it("accepts a page result without looking for an anchor or requesting a frame", async (context) => {
  await withFixture(context, false, async (f) => {
    await expect(f.reveal("page", "page")).resolves.toBe(true);
    expect(f.root.querySelector).not.toHaveBeenCalled();
    expect(f.requestFrame).not.toHaveBeenCalled();
  });
});

it("reveals a read-only row without manufacturing a focus control", async (context) => {
  await withFixture(context, false, async (f) => {
    const anchor = f.anchor("one", false);
    const frame = f.nextFrame();
    const reveal = f.reveal("one");
    f.flushFrame(await frame);
    await expect(reveal).resolves.toBe(true);
    expect(anchor.node.scrollIntoView).toHaveBeenCalledOnce();
    expect(anchor.highlighted()).toBe(true);
    expect(anchor.control.focus).not.toHaveBeenCalled();
    expect(anchor.order).toEqual(["scroll", "highlight"]);
  });
});

it("rejects a stale caller after the owned frame without scrolling, highlighting or focusing its anchor", async (context) => {
  await withFixture(context, false, async (f) => {
    let current = true;
    const anchor = f.anchor("private-provider");
    const frame = f.nextFrame();
    const result = f.reveal("private-provider", "setting", () => current);
    const id = await frame;
    current = false;
    f.flushFrame(id);
    await expect(result).resolves.toBe(false);
    expect(anchor.order).toEqual([]);
    expect(anchor.node.scrollIntoView).not.toHaveBeenCalled();
    expect(anchor.control.focus).not.toHaveBeenCalled();
    expect(anchor.highlighted()).toBe(false);
  });
});

it("does not let an already-stale caller cancel a current reveal or acquire a frame", async (context) => {
  await withFixture(context, false, async (f) => {
    const anchor = f.anchor("current-provider");
    const frame = f.nextFrame();
    const current = f.reveal("current-provider");
    const id = await frame;
    await expect(f.reveal("foreign-provider", "setting", () => false)).resolves.toBe(false);
    expect(f.requestFrame).toHaveBeenCalledTimes(1);
    f.flushFrame(id);
    await expect(current).resolves.toBe(true);
    expect(anchor.order).toEqual(["scroll", "highlight", "focus"]);
  });
});
