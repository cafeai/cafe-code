import "../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

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

describe("AmbianceLayer", () => {
  it("fills the viewport and paints visible weather pixels when enabled", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<AmbianceLayer />, { container: host });

    try {
      const canvas = host.querySelector('[data-cafe-ambiance-canvas="true"]');
      expect(canvas).toBeInstanceOf(HTMLCanvasElement);
      if (!(canvas instanceof HTMLCanvasElement)) {
        throw new Error("Ambiance canvas did not mount");
      }

      await vi.waitFor(
        () => {
          const rect = canvas.getBoundingClientRect();
          expect(rect.width).toBe(window.innerWidth);
          expect(rect.height).toBe(window.innerHeight);

          const context = canvas.getContext("2d");
          expect(context).not.toBeNull();
          if (!context) return;

          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
          let painted = false;
          for (let index = 3; index < pixels.length; index += 4) {
            if (pixels[index]! > 0) {
              painted = true;
              break;
            }
          }
          expect(painted).toBe(true);
        },
        { timeout: 3_000 },
      );
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("keeps the original visible ambiance painting through 24 native child-frame clicks", async () => {
    const host = document.createElement("div");
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
      await loaded;
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
      const removeObservers = observationOwners.map(([target, type, phase]) => {
        const listener = (event: Event) => observe(phase, event);
        target.addEventListener(type, listener);
        return () => target.removeEventListener(type, listener);
      });
      let screen: Awaited<ReturnType<typeof render>> | undefined;
      try {
        // Initial ownership is established by real input, not element.focus(),
        // a hasFocus stub or synthetic focus/blur delivery.
        await userEvent.click(parentControl);
        await expect.poll(() => document.activeElement).toBe(parentControl);
        expect(document.hasFocus()).toBe(true);
        expect(document.hidden).toBe(false);
        screen = await render(<AmbianceLayer />, { container: canvasHost });
        canvas = host.querySelector<HTMLCanvasElement>('[data-cafe-ambiance-canvas="true"]');
        expect(canvas).toBeInstanceOf(HTMLCanvasElement);
        expect(canvas?.dataset.cafeAmbianceEffect).toBe("lattice");
        expect(canvas?.dataset.cafeAmbianceBackend).toBe("2d");
        await expect.poll(completedFrames).toBeGreaterThan(1);
        expect(painted()).toBe(true);
        const before = completedFrames();
        const checkpoints: { click: number; focused: boolean; hidden: boolean; frames: number }[] =
          [];
        for (let index = 0; index < 24; index += 1) {
          await userEvent.click(nativeChildControl);
          await expect
            .poll(() => childDocument.documentElement.dataset.nativeTrustedClicks)
            .toBe(String(index + 1));
          // Observe native frame delivery; this does not schedule engine work,
          // simulate a clock or treat waiting itself as proof of painted motion.
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          });
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
      } finally {
        for (const remove of removeObservers) remove();
        try {
          await screen?.unmount();
        } finally {
          // The native call-through recorder belongs only to this fixture;
          // later files must not accumulate its canvas calls or retain owners.
          clears.mockRestore();
        }
      }
    } finally {
      host.remove();
    }
  });
});

describe("AmbianceLayer effect switching", () => {
  const canvasOf = (host: HTMLElement) =>
    host.querySelector<HTMLCanvasElement>('[data-cafe-ambiance-canvas="true"]');

  it("rebuilds the canvas when switching between two shader effects", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<AmbianceLayer />, { container: host });
    try {
      selectEffect("aurora");
      let first: HTMLCanvasElement | null = null;
      await vi.waitFor(() => {
        first = canvasOf(host);
        expect(first?.dataset.cafeAmbianceEffect).toBe("aurora");
      });

      // Every shader compiles its program once at construction, so switching
      // shader effects must replace the canvas — otherwise the layer keeps
      // drawing the previous program and the background never changes.
      selectEffect("grid");
      await vi.waitFor(() => {
        const next = canvasOf(host);
        expect(next?.dataset.cafeAmbianceEffect).toBe("grid");
        expect(next).not.toBe(first);
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("keeps one canvas across 2D effects so their pools carry over", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<AmbianceLayer />, { container: host });
    try {
      selectEffect("rain");
      let first: HTMLCanvasElement | null = null;
      await vi.waitFor(() => {
        first = canvasOf(host);
        expect(first?.dataset.cafeAmbianceEffect).toBe("rain");
      });

      selectEffect("glass");
      await vi.waitFor(() => {
        const next = canvasOf(host);
        expect(next?.dataset.cafeAmbianceEffect).toBe("glass");
        expect(next).toBe(first);
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
