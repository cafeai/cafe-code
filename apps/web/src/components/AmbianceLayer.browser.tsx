import "../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
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
