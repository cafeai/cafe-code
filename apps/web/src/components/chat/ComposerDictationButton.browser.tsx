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
    expect(
      document.querySelector(
        '[data-composer-dictation="true"] svg[data-dictation-glyph="mic"][data-visible="true"]',
      ),
    ).not.toBeNull();
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
    expect(
      document.querySelector(
        '[data-composer-dictation="true"] svg.fill-current[data-dictation-glyph="stop"][data-visible="true"]',
      ),
    ).not.toBeNull();
    await expect.element(page.getByRole("status")).toMatchTextContent("Listening");

    await mounted.rerender(
      <ComposerDictationButton
        phase="finalizing"
        statusMessage="Finishing dictation"
        onToggle={() => undefined}
      />,
    );
    await expect.element(page.getByRole("button", { name: "Finishing dictation" })).toBeDisabled();
    expect(
      document.querySelector(
        '[data-composer-dictation="true"] svg.animate-spin[data-dictation-glyph="spinner"][data-visible="true"]',
      ),
    ).not.toBeNull();
    // Hidden glyphs stay mounted for the crossfade but never animate.
    expect(
      document.querySelectorAll('[data-composer-dictation="true"] svg.animate-spin'),
    ).toHaveLength(1);
    await expect.element(page.getByRole("status")).toMatchTextContent("Finishing dictation");
  });
});
