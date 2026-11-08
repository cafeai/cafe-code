import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAC_TRAFFIC_LIGHTS_CLASS_NAME,
  syncDocumentMacTrafficLightsClass,
} from "./macTrafficLights";

function setup(platform: string, initialFullScreen: boolean, bridgeAvailable = true) {
  const classes = new Set<string>();
  const unsubscribe = vi.fn();
  let transition: ((fullScreen: boolean) => void) | undefined;
  const getWindowFullScreen = vi.fn(() => initialFullScreen);
  const onWindowFullScreenChanged = vi.fn((listener: (fullScreen: boolean) => void) => {
    transition = listener;
    return unsubscribe;
  });
  vi.stubGlobal("navigator", { platform });
  vi.stubGlobal("document", {
    documentElement: {
      classList: {
        toggle: (name: string, enabled: boolean) =>
          enabled ? classes.add(name) : classes.delete(name),
        remove: (...names: string[]) => names.forEach((name) => classes.delete(name)),
      },
    },
  });
  vi.stubGlobal("window", {
    desktopBridge: bridgeAvailable ? { getWindowFullScreen, onWindowFullScreenChanged } : undefined,
  });
  const cleanup = syncDocumentMacTrafficLightsClass();
  return {
    classes,
    cleanup,
    getWindowFullScreen,
    onWindowFullScreenChanged,
    unsubscribe,
    transition: (fullScreen: boolean) => transition?.(fullScreen),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("native macOS traffic-light presentation", () => {
  it.each([false, true])(
    "reconciles startup/reload state %s and later transitions",
    (fullScreen) => {
      const fixture = setup("MacIntel", fullScreen);
      try {
        expect(fixture.classes.has(MAC_TRAFFIC_LIGHTS_CLASS_NAME)).toBe(!fullScreen);
        expect(fixture.classes.has("mac-fullscreen")).toBe(fullScreen);
        fixture.transition(true);
        expect([...fixture.classes]).toEqual(["mac-fullscreen"]);
        fixture.transition(false);
        expect([...fixture.classes]).toEqual([MAC_TRAFFIC_LIGHTS_CLASS_NAME]);
      } finally {
        fixture.cleanup();
      }
      expect(fixture.unsubscribe).toHaveBeenCalledOnce();
      fixture.transition(true);
      expect(fixture.classes.size).toBe(0);
    },
  );

  it("retains traffic-light clearance with an older bridge", () => {
    const fixture = setup("MacIntel", true, false);
    try {
      expect([...fixture.classes]).toEqual([MAC_TRAFFIC_LIGHTS_CLASS_NAME]);
    } finally {
      fixture.cleanup();
    }
  });

  it.each(["Win32", "Linux x86_64"])("does not observe or apply Mac chrome on %s", (platform) => {
    const fixture = setup(platform, true);
    try {
      expect(fixture.classes.size).toBe(0);
      expect(fixture.getWindowFullScreen).not.toHaveBeenCalled();
      expect(fixture.onWindowFullScreenChanged).not.toHaveBeenCalled();
    } finally {
      fixture.cleanup();
    }
  });
});
