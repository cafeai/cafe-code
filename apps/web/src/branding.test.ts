import { afterEach, describe, expect, it, vi } from "vitest";

const originalWindow = globalThis.window;

afterEach(() => {
  vi.resetModules();

  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalThis, "window");
    return;
  }

  globalThis.window = originalWindow;
});

describe("branding", () => {
  it("uses injected desktop branding when available", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        desktopBridge: {
          getAppBranding: () => ({
            baseName: "Cafe Code",
            stageLabel: "Nightly",
            displayName: "Cafe Code (Nightly)",
          }),
        },
      },
    });

    const branding = await import("./branding");

    expect(branding.APP_BASE_NAME).toBe("Cafe Code");
    expect(branding.APP_STAGE_LABEL).toBe("Nightly");
    expect(branding.APP_DISPLAY_NAME).toBe("Cafe Code (Nightly)");
  });

  it("uses a fallback stage label without desktop branding", async () => {
    const branding = await import("./branding");

    expect(["Dev", "Alpha"]).toContain(branding.APP_STAGE_LABEL);
    expect(branding.APP_DISPLAY_NAME).toBe(`Cafe Code (${branding.APP_STAGE_LABEL})`);
  });
});
