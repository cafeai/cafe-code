import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerDictationButton } from "./ComposerDictationButton";

describe("ComposerDictationButton", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("exposes an outline microphone as a keyboard-accessible toggle", async () => {
    const onToggle = vi.fn();
    await render(
      <ComposerDictationButton phase="idle" statusMessage="Dictation ready" onToggle={onToggle} />,
    );

    const button = page.getByRole("button", { name: "Start dictation" });
    await expect.element(button).toHaveAttribute("aria-pressed", "false");
    await button.click();
    expect(onToggle).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-composer-dictation="true"] svg')).not.toBeNull();
  });

  it("announces recording and finalization without making the transcript a live region", async () => {
    const mounted = await render(
      <ComposerDictationButton
        phase="recording"
        statusMessage="Listening"
        onToggle={() => undefined}
      />,
    );
    await expect
      .element(page.getByRole("button", { name: "Stop dictation" }))
      .toHaveAttribute("aria-pressed", "true");
    await expect.element(page.getByRole("status")).toHaveTextContent("Listening");

    await mounted.rerender(
      <ComposerDictationButton
        phase="finalizing"
        statusMessage="Finishing dictation"
        onToggle={() => undefined}
      />,
    );
    await expect.element(page.getByRole("button", { name: "Finishing dictation" })).toBeDisabled();
    await expect.element(page.getByRole("status")).toHaveTextContent("Finishing dictation");
  });
});
