import "../../index.css";

import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";

import { applyInterfaceScalePercent } from "../../interfaceScale";
import { MAC_TRAFFIC_LIGHTS_CLASS_NAME } from "../../lib/macTrafficLights";
import { AlertDialog, AlertDialogPopup, AlertDialogTitle } from "./alert-dialog";
import { Dialog, DialogPopup, DialogTitle } from "./dialog";

// Matches --app-mac-titlebar-height: the fixed native band holding the macOS
// traffic lights (trafficLightPosition in apps/desktop/src/window/DesktopWindow.ts).
const MAC_TITLEBAR_HEIGHT = 50;

function TallBody() {
  return (
    <div className="min-h-0 overflow-y-auto">
      <div style={{ height: 3000 }} />
    </div>
  );
}

function renderDialog(kind: "dialog" | "alert-dialog", className: string, body: ReactNode) {
  return render(
    kind === "dialog" ? (
      <Dialog open>
        <DialogPopup className={className}>
          <DialogTitle>Fixture dialog</DialogTitle>
          {body}
        </DialogPopup>
      </Dialog>
    ) : (
      <AlertDialog open>
        <AlertDialogPopup className={className}>
          <AlertDialogTitle>Fixture dialog</AlertDialogTitle>
          {body}
        </AlertDialogPopup>
      </AlertDialog>
    ),
  );
}

async function measure(
  kind: "dialog" | "alert-dialog",
  className: string,
  body: ReactNode,
  macTrafficLights: boolean,
) {
  const root = document.documentElement;
  root.classList.toggle(MAC_TRAFFIC_LIGHTS_CLASS_NAME, macTrafficLights);
  const screen = await renderDialog(kind, className, body);
  try {
    const dialog = page.getByRole(kind === "dialog" ? "dialog" : "alertdialog", {
      name: "Fixture dialog",
    });
    await expect.element(dialog).toBeVisible();
    // Wait out the entrance transition so the measured box is the settled one.
    await new Promise((resolve) => window.setTimeout(resolve, 400));
    const popup = dialog.element();
    const title = popup.querySelector<HTMLElement>("h2");
    return {
      popup: popup.getBoundingClientRect(),
      title: title?.getBoundingClientRect() ?? null,
    };
  } finally {
    await screen.unmount();
    root.classList.remove(MAC_TRAFFIC_LIGHTS_CLASS_NAME);
  }
}

describe("dialog placement under native macOS window controls", () => {
  // 840×620 is the desktop window's minimum size. At 130% a max-w-2xl dialog
  // is nearly window-wide, so only vertical placement keeps it clear.
  it.each([
    { kind: "dialog" as const, scale: 80, className: "max-w-2xl" },
    { kind: "dialog" as const, scale: 130, className: "max-w-2xl" },
    { kind: "alert-dialog" as const, scale: 130, className: "max-w-2xl" },
  ])(
    "keeps a tall $kind below the traffic lights at $scale%",
    async ({ kind, scale, className }) => {
      await page.viewport(840, 620);
      applyInterfaceScalePercent(scale);
      try {
        const { popup, title } = await measure(kind, className, <TallBody />, true);
        expect(popup.top).toBeGreaterThanOrEqual(MAC_TITLEBAR_HEIGHT - 0.5);
        expect(title?.top ?? 0).toBeGreaterThanOrEqual(MAC_TITLEBAR_HEIGHT);
        expect(popup.bottom).toBeLessThanOrEqual(window.innerHeight);
      } finally {
        applyInterfaceScalePercent(100);
      }
    },
  );

  it("does not move an ordinary dialog that already clears the band", async () => {
    await page.viewport(840, 620);
    const body = <div style={{ height: 200 }} />;
    const elsewhere = await measure("dialog", "", body, false);
    const onMac = await measure("dialog", "", body, true);
    expect(onMac.popup.top).toBeCloseTo(elsewhere.popup.top, 1);
    expect(onMac.popup.left).toBeCloseTo(elsewhere.popup.left, 1);
  });
});
