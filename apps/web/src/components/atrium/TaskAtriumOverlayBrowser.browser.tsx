import "../../index.css";

import { page } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

// Electron detection is fixed at module initialization. Keep the browser
// boundary in its own module graph instead of pretending it changes at runtime.
vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("../../hooks/useSettings", () => ({
  useSettings: () => true,
}));
vi.mock("./TaskAtrium", () => ({
  TaskAtriumBoard: () => <div>Atrium content</div>,
}));

import { TaskAtriumOverlay } from "./TaskAtriumOverlay";
import { useTaskAtriumStore } from "./taskAtriumStore";

it("preserves browser placement on Windows even with a window-controls overlay", async () => {
  const root = document.documentElement;
  const originalWco = root.classList.contains("wco");
  const platformSpy = vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  root.classList.add("wco");
  useTaskAtriumStore.getState().setOpen(true);
  const screen = await render(<TaskAtriumOverlay />);
  try {
    await vi.waitFor(() => {
      const popup = page.getByRole("dialog", { name: "Task Atrium" }).element();
      const close = page.getByRole("button", { name: "Close Task Atrium" }).element();
      const gap = Number.parseFloat(getComputedStyle(root).fontSize);
      expect(popup.className).not.toContain("wco:[--cafe-atrium-titlebar-inset");
      expect(close.getBoundingClientRect().top).toBeCloseTo(gap, 1);
      expect(window.innerWidth - close.getBoundingClientRect().right).toBeCloseTo(gap, 1);
    });
    await page.getByRole("button", { name: "Close Task Atrium" }).click();
    await vi.waitFor(() => expect(useTaskAtriumStore.getState().open).toBe(false));
  } finally {
    useTaskAtriumStore.getState().setOpen(false);
    await screen.unmount();
    root.classList.toggle("wco", originalWco);
    platformSpy.mockRestore();
  }
});
