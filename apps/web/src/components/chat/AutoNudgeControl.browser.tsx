import "../../index.css";

import { DEFAULT_THREAD_AUTO_NUDGE_CONFIG, EnvironmentId, ThreadId } from "@cafecode/contracts";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { AutoNudgeControl } from "./AutoNudgeControl";

const environmentId = EnvironmentId.make("environment-auto-nudge-control");
const threadId = ThreadId.make("thread-auto-nudge-control");

describe("AutoNudgeControl", () => {
  it("starts minimized and saves an exact-thread prompt", async () => {
    const onConfigure = vi.fn(async () => undefined);
    const screen = await render(
      <AutoNudgeControl
        config={DEFAULT_THREAD_AUTO_NUDGE_CONFIG}
        environmentId={environmentId}
        onConfigure={onConfigure}
        saveError={null}
        saving={false}
        threadId={threadId}
      />,
    );

    try {
      await expect.element(page.getByText("Off", { exact: true })).toBeInTheDocument();
      await expect.element(page.getByLabelText("Prompt for this thread")).not.toBeInTheDocument();

      await page.getByLabelText("Open Auto Nudge").click();
      await page.getByLabelText("Prompt for this thread").fill("Continue only this thread.");
      await page.getByRole("button", { name: "Save prompt" }).click();

      expect(onConfigure).toHaveBeenCalledWith({
        mode: "off",
        prompt: "Continue only this thread.",
        backgroundContinuation: false,
      });
    } finally {
      await screen.unmount();
    }
  });

  it("shows background operation truthfully while the control is minimized", async () => {
    const screen = await render(
      <AutoNudgeControl
        config={{
          ...DEFAULT_THREAD_AUTO_NUDGE_CONFIG,
          authorityRevision: 2,
          mode: "steady-progress",
          prompt: "Continue this exact thread.",
          backgroundContinuation: true,
          armedAt: "2026-08-12T00:00:00.000Z",
        }}
        environmentId={environmentId}
        onConfigure={vi.fn(async () => undefined)}
        saveError={null}
        saving={false}
        threadId={threadId}
      />,
    );

    try {
      await expect
        .element(page.getByText("On - continues in background", { exact: true }))
        .toBeInTheDocument();
      await expect.element(page.getByLabelText("Prompt for this thread")).not.toBeInTheDocument();
      await page.getByLabelText("Open Auto Nudge").click();
      await expect.element(page.getByLabelText("Continue this thread in background")).toBeChecked();
    } finally {
      await screen.unmount();
    }
  });
});
