import "../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";

const ambianceHarness = vi.hoisted(() => {
  const state = {
    environmentStateById: {},
  };
  const useStore = Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
    getState: () => state,
  });
  const listeners = new Set<() => void>();
  return {
    listeners,
    notify: () => {
      for (const listener of listeners) listener();
    },
    settings: {
      ambianceEnabled: true,
      ambianceEffect: "rain",
      ambianceIntensity: 1,
      ambianceReactMode: "off",
      ambianceSurfaceSidebar: true,
      ambianceSurfaceThread: true,
      ambianceSurfaceComposer: true,
      ambianceColor: "",
      appAccentColor: "",
      themeAccentColor: "",
      continueBackgroundAnimations: true,
    },
    useStore,
  };
});

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useParams: () => ({}),
}));

// These canvas fixtures have no selected workspace or thread. Keep that input
// explicit so the workspace hook cannot load saved-host bootstrap/persistence
// through this fixture's intentionally isolated settings and store modules.
vi.mock("../environments/workspace", () => ({
  useWorkspaceEnvironmentId: () => null,
}));

// The app is built with the React Compiler, which memoizes AmbianceCanvas, so a
// parent re-render alone never reaches it. The mock has to be a real
// subscribable store for a settings change to propagate the way it does live.
vi.mock("../hooks/useSettings", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useSettings: (selector: (settings: typeof ambianceHarness.settings) => unknown) =>
      useSyncExternalStore(
        (onChange: () => void) => {
          ambianceHarness.listeners.add(onChange);
          return () => ambianceHarness.listeners.delete(onChange);
        },
        () => selector(ambianceHarness.settings),
      ),
  };
});

vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({ theme: "dark" }),
}));

vi.mock("../store", () => ({
  selectAnyThreadRunning: () => false,
  useStore: ambianceHarness.useStore,
}));

import { AmbianceLayer } from "../ambiance/AmbianceLayer";

/**
 * Lets a test change the mocked settings and push a re-render, so effect
 * switching goes through the same path the settings picker uses.
 */
function selectEffect(effect: string) {
  ambianceHarness.settings.ambianceEffect = effect;
  ambianceHarness.notify();
}

afterEach(() => {
  ambianceHarness.settings.ambianceEffect = "rain";
  ambianceHarness.settings.continueBackgroundAnimations = true;
  ambianceHarness.notify();
  document.documentElement.style.removeProperty("--cafe-ambiance-state-color");
  document.documentElement.style.removeProperty("--cafe-ambiance-composer-ring");
});

describe("optional ambiance stress qualification", () => {
  it("keeps the original visible ambiance painting through 24 native child-frame clicks", async (test) => {
    const host = document.createElement("div");
    const startedAt = performance.now();
    const phases: {
      phase: string;
      index: number | null;
      elapsedMs: number;
      trusted: boolean | null;
      frames: number;
    }[] = [];
    let currentIndex: number | null = null;
    let latestPhase = "fixture-start";
    let truncated = false;
    let retired = false;
    let finished = false;
    let observeFrames = () => 0;
    let restoreClears: (() => void) | undefined;
    const removeObservers: (() => void)[] = [];
    let rendering: ReturnType<typeof render> | undefined;
    let cleanupPromise: Promise<void> | undefined;
    const record = (phase: string, event?: Event) => {
      // A test deadline can finish while native input or rendering still awaits
      // its response. A late continuation cannot resume work after retirement.
      if (retired) throw new Error("Native ambiance qualification already retired");
      latestPhase = phase;
      if (phases.length === 128) {
        truncated = true;
        return;
      }
      phases.push({
        phase,
        index: currentIndex,
        elapsedMs: Math.round(performance.now() - startedAt),
        trusted: event?.isTrusted ?? null,
        frames: observeFrames(),
      });
    };
    const cleanup = () => {
      if (cleanupPromise) return cleanupPromise;
      retired = true;
      cleanupPromise = (async () => {
        try {
          // Fixed phase/count scalars only. Preserve failure observations even
          // if a native click times out before the final continuity assertion.
          if (!finished) {
            console.info("native-ambiance-qualification-phases", {
              latestPhase,
              currentIndex,
              truncated,
              phases,
            });
          }
        } finally {
          try {
            for (const remove of removeObservers.splice(0)) remove();
            // Own the pending render itself, not only a result assigned after
            // await. A hard timeout must join its eventual effect cleanup
            // before restoring the recorder or admitting the next fixture.
            const rendered = await rendering;
            await rendered?.unmount();
          } finally {
            restoreClears?.();
            host.remove();
          }
        }
      })();
      return cleanupPromise;
    };
    // Register before append/navigation or any await. The test-owned completion
    // hook joins this same one-shot cleanup if a hard deadline beats finally.
    test.onTestFinished(cleanup);
    const parentControl = document.createElement("button");
    const canvasHost = document.createElement("div");
    parentControl.type = "button";
    parentControl.textContent = "Native parent focus control";
    const frame = document.createElement("iframe");
    frame.title = "Native child focus fixture";
    frame.style.cssText = "display:block;width:360px;height:100px;border:0";
    // This fixture contains no chart store, provider, saved profile or network
    // resource. Its ordinary same-origin srcdoc matches the focus boundary of
    // an inline visualization without granting any production action authority.
    const loaded = new Promise<void>((resolve) => {
      frame.addEventListener("load", () => resolve(), { once: true });
    });
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"></head><body data-native-ambiance-child="true"><button id="native-child-control" type="button">Change range</button><output id="native-child-clicks">0</output><script>
      const button = document.getElementById('native-child-control');
      const output = document.getElementById('native-child-clicks');
      let clicks = 0;
      button.addEventListener('click', event => {
        if (!event.isTrusted) return;
        output.value = String(++clicks);
        document.documentElement.dataset.nativeTrustedClicks = String(clicks);
      });
      document.documentElement.dataset.nativeControlReady = 'true';
    </script></body></html>`;
    host.append(parentControl, frame, canvasHost);
    document.body.append(host);
    try {
      record("fixture-load-start");
      await loaded;
      record("fixture-load-complete");
      const childDocument = frame.contentDocument;
      const childWindow = frame.contentWindow;
      const childControl = childDocument?.querySelector<HTMLButtonElement>("#native-child-control");
      expect(childDocument?.readyState).toBe("complete");
      expect(childDocument?.body.dataset.nativeAmbianceChild).toBe("true");
      expect(childDocument?.documentElement.dataset.nativeControlReady).toBe("true");
      if (
        !childDocument ||
        !childWindow ||
        !childControl ||
        childControl.ownerDocument !== childDocument ||
        childControl.localName !== "button"
      ) {
        throw new Error("Native child focus fixture did not complete");
      }
      const nativeChildControl = page
        .frameLocator(page.elementLocator(frame))
        .getByRole("button", { name: "Change range", exact: true });

      ambianceHarness.settings.ambianceEffect = "lattice";
      ambianceHarness.settings.continueBackgroundAnimations = false;
      ambianceHarness.notify();
      // This spy forwards the original synchronous native clearRect unchanged.
      // Count only completed calls on the exact ambiance canvas, and separately
      // verify actual painted pixels. Invocation alone is not a paint oracle.
      const clears = vi.spyOn(CanvasRenderingContext2D.prototype, "clearRect");
      restoreClears = () => clears.mockRestore();
      let canvas: HTMLCanvasElement | null = null;
      const completedFrames = (): number =>
        clears.mock.contexts.reduce<number>(
          (count, context, index) =>
            count +
            Number(
              context instanceof CanvasRenderingContext2D &&
                context.canvas === canvas &&
                clears.mock.results[index]?.type === "return",
            ),
          0,
        );
      observeFrames = completedFrames;
      const painted = () => {
        if (!canvas) return false;
        const context = canvas.getContext("2d");
        if (!context) return false;
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let offset = 3; offset < pixels.length; offset += 4) {
          if (pixels[offset]! > 0) return true;
        }
        return false;
      };
      const chronology: {
        phase: string;
        trusted: boolean;
        focused: boolean;
        childFocused: boolean;
        hidden: boolean;
        activeFrame: boolean;
        activeChild: boolean;
        frames: number;
      }[] = [];
      const observe = (phase: string, event: Event) => {
        if (chronology.length >= 64) return;
        chronology.push({
          phase,
          trusted: event.isTrusted,
          focused: document.hasFocus(),
          childFocused: childDocument.hasFocus(),
          hidden: document.hidden,
          activeFrame: document.activeElement === frame,
          activeChild: childDocument.activeElement === childControl,
          frames: completedFrames(),
        });
      };
      const observationOwners: readonly [EventTarget, string, string][] = [
        [window, "blur", "parent-window-blur"],
        [window, "focus", "parent-window-focus"],
        [document, "focusin", "parent-document-focusin"],
        [document, "visibilitychange", "parent-visibility"],
        [childWindow, "blur", "child-window-blur"],
        [childWindow, "focus", "child-window-focus"],
        [childDocument, "focusin", "child-document-focusin"],
      ];
      removeObservers.push(
        ...observationOwners.map(([target, type, phase]) => {
          const listener = (event: Event) => observe(phase, event);
          target.addEventListener(type, listener);
          return () => target.removeEventListener(type, listener);
        }),
      );
      for (const type of ["pointerdown", "click"] as const) {
        const listener = (event: Event) => {
          if (!retired) record(`child-${type}`, event);
        };
        childControl.addEventListener(type, listener);
        removeObservers.push(() => childControl.removeEventListener(type, listener));
      }
      try {
        // Initial ownership is established by real input, not element.focus(),
        // a hasFocus stub or synthetic focus/blur delivery.
        await userEvent.click(parentControl);
        await expect.poll(() => document.activeElement).toBe(parentControl);
        expect(document.hasFocus()).toBe(true);
        expect(document.hidden).toBe(false);
        record("parent-focus-ready");
        rendering = render(<AmbianceLayer />, { container: canvasHost });
        await rendering;
        if (retired) {
          throw new Error("Native ambiance qualification already retired");
        }
        canvas = host.querySelector<HTMLCanvasElement>('[data-cafe-ambiance-canvas="true"]');
        expect(canvas).toBeInstanceOf(HTMLCanvasElement);
        expect(canvas?.dataset.cafeAmbianceEffect).toBe("lattice");
        expect(canvas?.dataset.cafeAmbianceBackend).toBe("2d");
        // A completed native clear can precede the engine's first nonempty
        // draw. Observe both prerequisites within the original single poll
        // allowance before measuring continuity through child-frame input.
        await expect.poll(() => completedFrames() > 1 && painted()).toBe(true);
        expect(completedFrames()).toBeGreaterThan(1);
        expect(painted()).toBe(true);
        record("initial-paint-ready");
        const before = completedFrames();
        const checkpoints: { click: number; focused: boolean; hidden: boolean; frames: number }[] =
          [];
        for (let index = 0; index < 24; index += 1) {
          currentIndex = index;
          record("child-click-start");
          await userEvent.click(nativeChildControl);
          record("child-click-returned");
          await expect
            .poll(() => childDocument.documentElement.dataset.nativeTrustedClicks)
            .toBe(String(index + 1));
          // Observe native frame delivery; this does not schedule engine work,
          // simulate a clock or treat waiting itself as proof of painted motion.
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          });
          record("child-frames-complete");
          checkpoints.push({
            click: index + 1,
            focused: document.hasFocus(),
            hidden: document.hidden,
            frames: completedFrames(),
          });
        }
        expect(document.hasFocus()).toBe(true);
        expect(document.hidden).toBe(false);
        expect(document.activeElement).toBe(frame);
        expect(childDocument.activeElement).toBe(childControl);
        expect(frame.contentDocument).toBe(childDocument);
        expect(host.querySelector('[data-cafe-ambiance-canvas="true"]')).toBe(canvas);
        expect(childDocument.documentElement.dataset.nativeTrustedClicks).toBe("24");
        expect(painted()).toBe(true);
        const after = completedFrames();
        // Keep the original-source failure's evidence fixed, bounded and
        // content-free: no received HTML, pixels, paths or user/profile data.
        if (
          after <= before ||
          checkpoints.some(
            (checkpoint, index) =>
              checkpoint.frames <= (index === 0 ? before : checkpoints[index - 1]!.frames),
          )
        ) {
          throw new Error(
            `Native child focus stalled visible ambiance: ${JSON.stringify({
              before,
              after,
              reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
              chronology,
              checkpoints,
            })}`,
          );
        }
        finished = true;
      } finally {
        await cleanup();
      }
    } finally {
      await cleanup();
    }
  });
});
