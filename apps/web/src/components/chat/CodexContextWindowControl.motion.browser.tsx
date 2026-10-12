import "../../index.css";
import { page, userEvent } from "vitest/browser";
import { afterEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { CodexContextWindowControl } from "./CodexContextWindowControl";
import { deriveCodexContextWindowPresentation } from "../../codexContextWindow";

let mounted: Awaited<ReturnType<typeof render>> | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

// This file runs only in a provider-owned reduced-motion context. No CDP or
// matchMedia mutation leaks device policy onto an ordinary desktop worker.
it("retains accessible context-dialog input and stationary reduced-motion geometry", async () => {
  expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
  mounted = await render(
    <CodexContextWindowControl
      open
      onOpenChange={() => {}}
      supported
      override={500_000}
      presentation={deriveCodexContextWindowPresentation({
        requested: 500_000,
        configured: 500_000,
      })}
      onChange={async () => {}}
    />,
  );
  const dialog = page.getByRole("dialog").element();
  const style = getComputedStyle(dialog);
  expect(style.transform).toBe("none");
  expect(style.translate === "none" || style.translate === "0px").toBe(true);
  const input = page.getByRole("spinbutton", { name: "Context window (tokens)", exact: true });
  await input.fill("600000");
  input.element().focus();
  await userEvent.keyboard("{Tab}");
  expect(document.activeElement).toBe(
    page.getByRole("button", { name: "About context-window overrides", exact: true }).element(),
  );
  await expect.element(page.getByText("Source: Chat override.", { exact: true })).toBeVisible();
  await expect.element(input).toHaveValue(600_000);
});
