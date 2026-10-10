import "../index.css";

import type { DesktopBridge } from "@cafecode/contracts";
import { cdp, page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { copyPngToClipboard, savePngToDisk } from "../lib/imageExport";
import { ImageExportMenu } from "./ImageExportMenu";
import { toastManager } from "./ui/toast";

const bridgeDescriptor = Object.getOwnPropertyDescriptor(window, "desktopBridge");

function transportFixture() {
  const copyPng = vi.fn<(png: Uint8Array) => Promise<void>>().mockResolvedValue();
  const savePng = vi.fn<DesktopBridge["savePng"]>().mockResolvedValue("saved");
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { copyPng, savePng },
  });
  return { copyPng, savePng };
}

async function pngFixture(): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = 16;
  canvas.height = 12;
  canvas.getContext("2d")!.fillRect(0, 0, 16, 12);
  return new Promise((resolve) => canvas.toBlob((png) => resolve(png!), "image/png"));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (bridgeDescriptor) Object.defineProperty(window, "desktopBridge", bridgeDescriptor);
  else Reflect.deleteProperty(window, "desktopBridge");
});

describe("shared image export menu", () => {
  it.each([
    { theme: "light", scale: 80 },
    { theme: "light", scale: 130 },
    { theme: "dark", scale: 80 },
    { theme: "dark", scale: 130 },
  ])("supports keyboard actions in narrow $theme $scale% layouts", async ({ theme, scale }) => {
    const originalViewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(360, 420);
    const root = document.documentElement;
    const originalClass = root.className;
    const originalFont = root.style.fontSize;
    const originalMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const input = cdp();
    await input.send("Emulation.setEmulatedMedia", {
      features: [
        { name: "prefers-reduced-motion", value: scale === 130 ? "reduce" : "no-preference" },
      ],
    });
    root.classList.toggle("dark", theme === "dark");
    root.style.fontSize = `${scale}%`;
    const transport = transportFixture();
    const toast = vi.spyOn(toastManager, "add");
    const png = await pngFixture();
    const screen = await render(
      <ImageExportMenu
        label="Table"
        contentKey="one"
        createPng={() => Promise.resolve(png)}
        suggestedName="table.png"
      />,
    );
    try {
      const trigger = page.getByRole("button", { name: "Table image actions", exact: true });
      trigger.element().focus();
      await userEvent.keyboard("{Enter}");
      const menu = page.getByRole("menu");
      await expect.element(menu).toBeVisible();
      const rect = menu.element().getBoundingClientRect();
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
      await userEvent.keyboard("{Home}{Enter}");
      await vi.waitFor(() => expect(transport.copyPng).toHaveBeenCalledTimes(1));
      await vi.waitFor(() =>
        expect(toast).toHaveBeenCalledWith(
          expect.objectContaining({ type: "success", title: "Table image copied" }),
        ),
      );
      await expect.element(trigger).toHaveFocus();
      expect(transport.savePng).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
      root.className = originalClass;
      root.style.fontSize = originalFont;
      await input.send("Emulation.setEmulatedMedia", {
        features: [
          { name: "prefers-reduced-motion", value: originalMotion ? "reduce" : "no-preference" },
        ],
      });
      await page.viewport(originalViewport.width, originalViewport.height);
    }
  });

  it("cancels retired preparation without writing another source or showing late feedback", async () => {
    const transport = transportFixture();
    const toast = vi.spyOn(toastManager, "add");
    let finish!: (blob: Blob) => void;
    let signal!: AbortSignal;
    const createPng = vi.fn((received: AbortSignal) => {
      signal = received;
      return new Promise<Blob>((resolve) => {
        finish = resolve;
      });
    });
    const screen = await render(
      <ImageExportMenu
        label="Diagram"
        contentKey="old"
        createPng={createPng}
        suggestedName="diagram.png"
      />,
    );
    try {
      await page.getByRole("button", { name: "Diagram image actions" }).click();
      await page.getByRole("menuitem", { name: "Copy image", exact: true }).click();
      expect(createPng).toHaveBeenCalledTimes(1);
      await screen.rerender(
        <ImageExportMenu
          label="Diagram"
          contentKey="new"
          createPng={createPng}
          suggestedName="diagram.png"
        />,
      );
      expect(signal.aborted).toBe(true);
      finish(await pngFixture());
      await vi.waitFor(() => expect(transport.copyPng).not.toHaveBeenCalled());
      expect(toast).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps cancellation quiet and masks private transport failures", async () => {
    const transport = transportFixture();
    const toast = vi.spyOn(toastManager, "add");
    const png = await pngFixture();
    transport.savePng.mockResolvedValueOnce("cancelled").mockResolvedValueOnce("failed");
    const screen = await render(
      <ImageExportMenu
        label="Diagram"
        contentKey="one"
        createPng={() => Promise.resolve(png)}
        suggestedName="diagram.png"
      />,
    );
    try {
      const trigger = page.getByRole("button", { name: "Diagram image actions" });
      await trigger.click();
      await page.getByRole("menuitem", { name: "Save as PNG", exact: true }).click();
      await vi.waitFor(() => expect(transport.savePng).toHaveBeenCalledTimes(1));
      await expect.element(trigger).toBeEnabled();
      expect(toast).not.toHaveBeenCalled();
      await trigger.click();
      await page.getByRole("menuitem", { name: "Save as PNG", exact: true }).click();
      await vi.waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
      expect(toast.mock.calls[0]![0].title).toBe("Couldn't save image");
      transport.copyPng.mockRejectedValueOnce(new Error("PRIVATE SOURCE /private/destination"));
      await expect.element(trigger).toBeEnabled();
      await trigger.click();
      await page.getByRole("menuitem", { name: "Copy image", exact: true }).click();
      await vi.waitFor(() => expect(toast).toHaveBeenCalledTimes(2));
      expect(JSON.stringify(toast.mock.calls)).not.toMatch(/PRIVATE SOURCE|private\/destination/);
    } finally {
      await screen.unmount();
    }
  });

  it("admits only one pending action and retires unmounted preparation", async () => {
    const transport = transportFixture();
    const toast = vi.spyOn(toastManager, "add");
    let finish!: (blob: Blob) => void;
    let signal!: AbortSignal;
    const createPng = vi.fn((received: AbortSignal) => {
      signal = received;
      return new Promise<Blob>((resolve) => {
        finish = resolve;
      });
    });
    const screen = await render(
      <ImageExportMenu
        label="Table"
        contentKey="one"
        createPng={createPng}
        suggestedName="table.png"
      />,
    );
    const trigger = page.getByRole("button", { name: "Table image actions" });
    await trigger.click();
    await page.getByRole("menuitem", { name: "Copy image", exact: true }).click();
    await trigger.click();
    await expect
      .element(page.getByRole("menuitem", { name: "Copy image", exact: true }))
      .toHaveAttribute("data-disabled", "");
    await expect
      .element(page.getByRole("menuitem", { name: "Save as PNG", exact: true }))
      .toHaveAttribute("data-disabled", "");
    expect(createPng).toHaveBeenCalledTimes(1);
    await screen.unmount();
    expect(signal.aborted).toBe(true);
    finish(await pngFixture());
    await vi.waitFor(() => expect(transport.copyPng).not.toHaveBeenCalled());
    expect(transport.savePng).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });
});

describe("browser image transport", () => {
  it("starts image clipboard admission in the gesture before rasterization settles", async () => {
    Reflect.deleteProperty(window, "desktopBridge");
    let supplied!: Promise<Blob>;
    vi.stubGlobal(
      "ClipboardItem",
      class {
        readonly types = ["image/png"];
        constructor(items: Record<string, Promise<Blob>>) {
          supplied = items["image/png"]!;
        }
      },
    );
    const write = vi.fn().mockResolvedValue(undefined);
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write } });
    let finish!: (blob: Blob) => void;
    const pending = new Promise<Blob>((resolve) => {
      finish = resolve;
    });
    try {
      const copied = copyPngToClipboard(pending, new AbortController().signal);
      expect(write).toHaveBeenCalledTimes(1);
      const png = await pngFixture();
      finish(png);
      expect(await supplied).toBe(png);
      await copied;
    } finally {
      if (original) Object.defineProperty(navigator, "clipboard", original);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("rejects revoked promised image bytes before clipboard admission", async () => {
    Reflect.deleteProperty(window, "desktopBridge");
    let supplied!: Promise<Blob>;
    vi.stubGlobal(
      "ClipboardItem",
      class {
        readonly types = ["image/png"];
        constructor(items: Record<string, Promise<Blob>>) {
          supplied = items["image/png"]!;
        }
      },
    );
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write: () => supplied.then(() => undefined) },
    });
    const controller = new AbortController();
    let finish!: (blob: Blob) => void;
    const pending = new Promise<Blob>((resolve) => {
      finish = resolve;
    });
    try {
      const copied = copyPngToClipboard(pending, controller.signal);
      const failure = expect(copied).rejects.toThrow();
      controller.abort();
      finish(await pngFixture());
      await failure;
    } finally {
      if (original) Object.defineProperty(navigator, "clipboard", original);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("dispatches a PNG download with a safe basename without a success toast", async () => {
    Reflect.deleteProperty(window, "desktopBridge");
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });
    const toast = vi.spyOn(toastManager, "add");
    const result = await savePngToDisk(
      Promise.resolve(await pngFixture()),
      "table.png",
      new AbortController().signal,
    );
    expect(result).toBe("saved");
    expect(clicked).toHaveLength(1);
    expect(clicked[0]!.download).toBe("table.png");
    expect(clicked[0]!.href).toMatch(/^blob:/);
    expect(clicked[0]!.isConnected).toBe(false);
    expect(toast).not.toHaveBeenCalled();
    await expect(
      savePngToDisk(
        Promise.resolve(await pngFixture()),
        "../private.png",
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(clicked).toHaveLength(1);
  });
});
