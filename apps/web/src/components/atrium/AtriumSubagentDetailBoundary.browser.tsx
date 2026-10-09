import "../../index.css";

import { useRef, useState } from "react";
import { page } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { AtriumSubagentDetailBoundary } from "./AtriumSubagentDetailBoundary";

const PRIVATE_DIAGNOSTIC = "synthetic private detail diagnostic";

function Detail({ failed }: { failed: boolean }) {
  if (failed) throw new Error(PRIVATE_DIAGNOSTIC);
  return <p>Public activity for the newly selected worker</p>;
}

function BoardFixture() {
  const backButtonRef = useRef<HTMLButtonElement | null>(null);
  const [selection, setSelection] = useState<"failed" | "new" | null>("failed");
  const [navigationCount, setNavigationCount] = useState(0);
  return (
    <div className="w-full max-w-full">
      <button type="button" onClick={() => setNavigationCount((count) => count + 1)}>
        Board navigation {navigationCount}
      </button>
      <button type="button" onClick={() => setSelection("new")}>
        Open another worker
      </button>
      <button type="button" onClick={() => setSelection("failed")}>
        Open broken worker
      </button>
      {selection ? (
        <div className="h-64 w-full" role="dialog" aria-label="Subagent activity">
          <AtriumSubagentDetailBoundary
            key={selection}
            backButtonRef={backButtonRef}
            onBack={() => setSelection(null)}
          >
            <Detail failed={selection === "failed"} />
          </AtriumSubagentDetailBoundary>
        </div>
      ) : (
        <p>Worker view closed</p>
      )}
    </div>
  );
}

it.each([
  ["light", 80],
  ["light", 130],
  ["dark", 80],
  ["dark", 130],
] as const)("contains a worker render failure in %s at %i%% scale", async (theme, scale) => {
  const root = document.documentElement;
  const originalDark = root.classList.contains("dark");
  const originalFontSize = root.style.fontSize;
  const originalViewport = { width: window.innerWidth, height: window.innerHeight };
  root.classList.toggle("dark", theme === "dark");
  root.style.fontSize = `${scale}%`;
  await page.viewport(320, 360);
  // React reports caught render failures to console in development. This
  // fixture deliberately throws synthetic text; no real provider is involved.
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const screen = await render(<BoardFixture />);
  try {
    const back = page.getByRole("button", { name: "Back to Atrium", exact: true });
    await expect.element(back).toBeVisible();
    expect(document.activeElement).toBe(back.element());
    await expect
      .element(page.getByText("Subagent activity unavailable", { exact: true }))
      .toBeVisible();
    expect(document.body.textContent).not.toContain(PRIVATE_DIAGNOSTIC);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);

    // A failed child cannot take over the board or strand its exit action.
    await page.getByRole("button", { name: "Board navigation 0", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "Board navigation 1", exact: true }))
      .toBeVisible();

    // Change identity while the failed boundary is still mounted: removing
    // the popup first would not qualify the key-based failure-state reset.
    await page.getByRole("button", { name: "Open another worker", exact: true }).click();
    await expect
      .element(page.getByText("Public activity for the newly selected worker"))
      .toBeVisible();
    expect(document.body.textContent).not.toContain("Subagent activity unavailable");

    // Independently verify that a new failure retains its usable local exit.
    await page.getByRole("button", { name: "Open broken worker", exact: true }).click();
    await expect.element(back).toBeVisible();
    expect(document.activeElement).toBe(back.element());
    await back.click();
    await expect.element(page.getByText("Worker view closed", { exact: true })).toBeVisible();
    expect(
      page.getByRole("dialog", { name: "Subagent activity", exact: true }).elements(),
    ).toHaveLength(0);
  } finally {
    await screen.unmount();
    consoleError.mockRestore();
    root.classList.toggle("dark", originalDark);
    root.style.fontSize = originalFontSize;
    await page.viewport(originalViewport.width, originalViewport.height);
  }
});
