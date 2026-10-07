import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import {
  DICTATION_REWRITE_INSTRUCTIONS_MAX_CHARS,
  type DictationRewriteTextInput,
} from "@cafecode/contracts";

import {
  GlobalDictationInsertError,
  GlobalDictationOverlay,
  type GlobalDictationOverlayProps,
  type GlobalDictationVoiceCommandControl,
} from "./GlobalDictationOverlay";

function props(overrides: Partial<GlobalDictationOverlayProps> = {}): GlobalDictationOverlayProps {
  return {
    sessionId: "session-one",
    phase: "review",
    transcript: "Hello, WORLD!",
    onStopRecording: vi.fn(),
    onCancel: vi.fn(),
    onCopy: vi.fn(),
    onSave: vi.fn(),
    onInsert: vi.fn(),
    ...overrides,
  };
}

describe("GlobalDictationOverlay", () => {
  it.each([
    { width: 490, height: 510 },
    { width: 360, height: 360 },
  ])(
    "explains guarded paste and keeps its action visible at $width × $height",
    async ({ width, height }) => {
      const originalViewport = { width: window.innerWidth, height: window.innerHeight };
      await page.viewport(width, height);
      const host = document.createElement("div");
      host.style.cssText = "position: fixed; inset: 0;";
      document.body.append(host);
      const onInsert = vi.fn();
      const onCopy = vi.fn();
      const screen = await render(
        <GlobalDictationOverlay {...props({ insertionMethod: "paste", onInsert, onCopy })} />,
        { container: host },
      );
      try {
        const footer = host.querySelector<HTMLElement>(".cafe-global-dictation__review-footer")!;
        const notice = page.getByText(/Clipboard-history apps may retain the draft/).element();
        const paste = page.getByRole("button", { name: "Paste into app", exact: true });
        await expect
          .element(page.getByRole("button", { name: "Insert", exact: true }))
          .not.toBeInTheDocument();
        await expect.element(paste).toHaveAttribute("aria-describedby", notice.id);
        // The visible notice is the one explanation; no duplicate hover title.
        expect(paste.element().hasAttribute("title")).toBe(false);
        await page.getByRole("textbox", { name: "Editable draft" }).fill("My reviewed paste.");
        const footerBounds = footer.getBoundingClientRect();
        expect(footerBounds.bottom).toBeLessThanOrEqual(window.innerHeight);
        expect(notice.getBoundingClientRect().top).toBeGreaterThanOrEqual(footerBounds.top);
        expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth);
        for (const name of ["Cancel", "Copy", "Save text…", "Paste into app"]) {
          const bounds = page
            .getByRole("button", { name, exact: true })
            .element()
            .getBoundingClientRect();
          expect(bounds.left).toBeGreaterThanOrEqual(footerBounds.left);
          expect(bounds.right).toBeLessThanOrEqual(footerBounds.right);
          expect(bounds.bottom).toBeLessThanOrEqual(footerBounds.bottom);
        }
        // Selecting the native paste method changes only this explicit action;
        // showing its notice must never copy or submit the draft on its own.
        expect(onInsert).not.toHaveBeenCalled();
        expect(onCopy).not.toHaveBeenCalled();
        await paste.click();
        expect(onInsert).toHaveBeenCalledExactlyOnceWith("My reviewed paste.");
        expect(onCopy).not.toHaveBeenCalled();
      } finally {
        await screen.unmount();
        host.remove();
        await page.viewport(originalViewport.width, originalViewport.height);
      }
    },
  );

  it("shows the clipboard caveat after an uncertain paste in the constrained review", async () => {
    const originalViewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(360, 360);
    const host = document.createElement("div");
    host.style.cssText = "position: fixed; inset: 0;";
    document.body.append(host);
    const onInsert = vi.fn(async () => {
      throw new GlobalDictationInsertError("insertion_uncertain", "paste");
    });
    const screen = await render(
      <GlobalDictationOverlay {...props({ insertionMethod: "paste", onInsert })} />,
      { container: host },
    );
    try {
      await page.getByRole("button", { name: "Paste into app", exact: true }).click();
      const feedback = page.getByText(/The draft may remain on the clipboard/);
      await expect.element(feedback).toBeInTheDocument();
      expect(feedback.element().textContent).toContain("will not repeat the paste automatically");
      expect(document.body.textContent).not.toContain("Nothing was pasted");
      await expect
        .element(page.getByRole("textbox", { name: "Editable draft" }))
        .toHaveValue("Hello, WORLD!");
      const paneBounds = host
        .querySelector<HTMLElement>(".cafe-global-dictation__review-body")!
        .getBoundingClientRect();
      const feedbackBounds = feedback.element().getBoundingClientRect();
      expect(feedbackBounds.top).toBeGreaterThanOrEqual(paneBounds.top);
      expect(feedbackBounds.bottom).toBeLessThanOrEqual(paneBounds.bottom + 1);
      expect(onInsert).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
      host.remove();
      await page.viewport(originalViewport.width, originalViewport.height);
    }
  });

  it("keeps Copy and Save available when clipboard preparation prevents paste", async () => {
    const onInsert = vi.fn(async () => {
      throw new GlobalDictationInsertError("clipboard_unavailable", "paste");
    });
    const screen = await render(
      <GlobalDictationOverlay {...props({ insertionMethod: "paste", onInsert })} />,
    );
    try {
      await page.getByRole("button", { name: "Paste into app", exact: true }).click();
      await expect
        .element(page.getByText(/could not prepare the clipboard. Nothing was pasted/))
        .toBeInTheDocument();
      await expect.element(page.getByRole("button", { name: "Copy", exact: true })).toBeEnabled();
      await expect.element(page.getByRole("button", { name: "Save text…" })).toBeEnabled();
      expect(onInsert).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  });

  it("fits the editable draft, styles, voice command, and actions in the compact review window", async () => {
    const originalViewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(490, 510);
    const host = document.createElement("div");
    host.style.cssText = "position: fixed; inset: 0;";
    document.body.append(host);
    const screen = await render(
      <GlobalDictationOverlay
        {...props({
          rewriteText: vi.fn(async () => "A formal draft."),
          voiceCommand: { phase: "idle", onStart: vi.fn(), onStop: vi.fn() },
        })}
      />,
      { container: host },
    );
    try {
      const pane = host.querySelector<HTMLElement>(".cafe-global-dictation__review-body")!;
      const footer = host.querySelector<HTMLElement>(".cafe-global-dictation__review-footer")!;
      const editor = page.getByRole("textbox", { name: "Editable draft" }).element();
      const paneBounds = pane.getBoundingClientRect();
      const footerBounds = footer.getBoundingClientRect();
      expect(editor.getBoundingClientRect().height).toBeGreaterThanOrEqual(128);
      // The default compact panel should need no scrolling. A long transcript
      // scrolls within the editor instead of growing the native window.
      expect(pane.scrollHeight).toBeLessThanOrEqual(pane.clientHeight + 1);
      expect(footerBounds.bottom).toBeLessThanOrEqual(window.innerHeight);
      expect(window.innerHeight - footerBounds.bottom).toBeLessThanOrEqual(24);
      for (const name of [
        "As transcribed",
        "lowercase",
        "no punctuation",
        "lowercase + no punctuation",
        "Formal",
        "Custom",
        "Start voice style command",
      ]) {
        const button = page.getByRole("button", { name, exact: true }).element();
        const bounds = button.getBoundingClientRect();
        expect(bounds.top).toBeGreaterThanOrEqual(paneBounds.top);
        expect(bounds.bottom).toBeLessThanOrEqual(paneBounds.bottom);
        expect(bounds.right).toBeLessThanOrEqual(paneBounds.right);
      }
      for (const name of ["Cancel", "Copy", "Save text…", "Insert"]) {
        const button = page.getByRole("button", { name, exact: true }).element();
        const bounds = button.getBoundingClientRect();
        expect(bounds.top).toBeGreaterThanOrEqual(footerBounds.top);
        expect(bounds.bottom).toBeLessThanOrEqual(footerBounds.bottom);
        expect(bounds.right).toBeLessThanOrEqual(footerBounds.right);
      }
    } finally {
      await screen.unmount();
      host.remove();
      await page.viewport(originalViewport.width, originalViewport.height);
    }
  });

  it("keeps actions visible while a constrained review scrolls through expanded content", async () => {
    const originalViewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(360, 360);
    const host = document.createElement("div");
    host.style.cssText = "position: fixed; inset: 0;";
    document.body.append(host);
    const onCopy = vi.fn();
    const screen = await render(
      <GlobalDictationOverlay
        {...props({
          transcript: "A long transcript that remains editable.\n".repeat(40),
          statusMessage: "Review the original app before inserting your text.",
          onCopy,
        })}
      />,
      { container: host },
    );
    try {
      const pane = host.querySelector<HTMLElement>(".cafe-global-dictation__review-body")!;
      const footer = host.querySelector<HTMLElement>(".cafe-global-dictation__review-footer")!;
      await page.getByRole("textbox", { name: "Editable draft" }).fill("My reviewed draft.");
      await page.getByText("Compare original transcript", { exact: true }).click();
      await page.getByRole("button", { name: "lowercase", exact: true }).click();
      await expect.element(page.getByRole("button", { name: "Keep edits" })).toBeInTheDocument();
      expect(getComputedStyle(pane).overflowY).toBe("auto");
      expect(pane.scrollHeight).toBeGreaterThan(pane.clientHeight);
      expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth);
      const footerBeforeScroll = footer.getBoundingClientRect();
      expect(footerBeforeScroll.bottom).toBeLessThanOrEqual(window.innerHeight);

      pane.scrollTop = pane.scrollHeight;
      expect(footer.getBoundingClientRect().top).toBe(footerBeforeScroll.top);
      const copy = page.getByRole("button", { name: "Copy", exact: true });
      const copyBounds = copy.element().getBoundingClientRect();
      // A visible box can still be obscured by overflowing content. Verify the
      // footer really owns its hit target after the middle pane is scrolled.
      expect(
        copy
          .element()
          .contains(
            document.elementFromPoint(
              copyBounds.left + copyBounds.width / 2,
              copyBounds.top + copyBounds.height / 2,
            ),
          ),
      ).toBe(true);
      await copy.click();
      expect(onCopy).toHaveBeenCalledExactlyOnceWith("My reviewed draft.");
      // Export keeps the reviewed text and revokes any pending replacement.
      await expect
        .element(page.getByRole("button", { name: "Keep edits" }))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByRole("textbox", { name: "Editable draft" }))
        .toHaveValue("My reviewed draft.");
    } finally {
      await screen.unmount();
      host.remove();
      await page.viewport(originalViewport.width, originalViewport.height);
    }
  });

  it.each([
    { width: 490, height: 510 },
    { width: 360, height: 360 },
  ])("keeps expanded custom instructions usable at $width × $height", async ({ width, height }) => {
    const originalViewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(width, height);
    const host = document.createElement("div");
    host.style.cssText = "position: fixed; inset: 0;";
    document.body.append(host);
    const rewriteText = vi.fn(async () => "A styled draft.");
    const screen = await render(
      <GlobalDictationOverlay {...props({ rewriteText, insertionMethod: "paste" })} />,
      { container: host },
    );
    try {
      await page.getByRole("button", { name: "Custom", exact: true }).click();
      await page
        .getByRole("textbox", { name: "Custom style instructions" })
        .fill("Warm, concise, and keep names unchanged.");
      const pane = host.querySelector<HTMLElement>(".cafe-global-dictation__review-body")!;
      const footer = host.querySelector<HTMLElement>(".cafe-global-dictation__review-footer")!;
      expect(pane.scrollHeight).toBeGreaterThan(pane.clientHeight);
      const footerBounds = footer.getBoundingClientRect();
      expect(footerBounds.bottom).toBeLessThanOrEqual(height);
      await page.getByRole("button", { name: "Apply custom style" }).click();
      const allow = page.getByRole("button", { name: "Allow & rewrite" });
      const allowBounds = allow.element().getBoundingClientRect();
      const paneBounds = pane.getBoundingClientRect();
      expect(allowBounds.top).toBeGreaterThanOrEqual(paneBounds.top - 1);
      expect(allowBounds.bottom).toBeLessThanOrEqual(paneBounds.bottom + 1);
      expect(footer.getBoundingClientRect().top).toBe(footerBounds.top);
      for (const name of ["Cancel", "Copy", "Save text…", "Paste into app"]) {
        const bounds = page
          .getByRole("button", { name, exact: true })
          .element()
          .getBoundingClientRect();
        expect(bounds.right).toBeLessThanOrEqual(footerBounds.right);
        expect(bounds.bottom).toBeLessThanOrEqual(height);
      }
      expect(rewriteText).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
      host.remove();
      await page.viewport(originalViewport.width, originalViewport.height);
    }
  });

  it("keeps the recording HUD non-editable and offers an explicit stop-to-review action", async () => {
    const onStopRecording = vi.fn();
    const screen = await render(
      <GlobalDictationOverlay
        {...props({
          phase: "recording",
          liveTranscript: "A few spoken words",
          onStopRecording,
        })}
      />,
    );
    try {
      await expect.element(page.getByText("Listening to you")).toBeInTheDocument();
      await expect.element(page.getByText("A few spoken words")).toBeInTheDocument();
      await expect.element(page.getByRole("textbox")).not.toBeInTheDocument();
      await page.getByRole("button", { name: "Stop & review" }).click();
      expect(onStopRecording).toHaveBeenCalledOnce();
      await screen.rerender(<GlobalDictationOverlay {...props({ phase: "finalizing" })} />);
      await expect.element(page.getByRole("button", { name: "Finishing" })).toBeDisabled();
    } finally {
      await screen.unmount();
    }
  });

  it("shows an editable draft and sends only the approved text to explicit actions", async () => {
    const onCopy = vi.fn();
    const onSave = vi.fn();
    const onInsert = vi.fn();
    const screen = await render(
      <GlobalDictationOverlay {...props({ onCopy, onSave, onInsert })} />,
    );
    try {
      const draft = page.getByRole("textbox", { name: "Editable draft" });
      await expect.element(draft).toHaveValue("Hello, WORLD!");
      await draft.fill("My edited text.");
      await page.getByRole("button", { name: "Copy", exact: true }).click();
      await page.getByRole("button", { name: "Save text…" }).click();
      await page.getByRole("button", { name: "Insert", exact: true }).click();
      expect(onCopy).toHaveBeenCalledExactlyOnceWith("My edited text.");
      expect(onSave).toHaveBeenCalledExactlyOnceWith("My edited text.");
      expect(onInsert).toHaveBeenCalledExactlyOnceWith("My edited text.");
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the draft and warns against duplicate writes after an uncertain insert", async () => {
    const onCopy = vi.fn();
    const onInsert = vi.fn(async () => {
      throw new GlobalDictationInsertError("insertion_uncertain");
    });
    const screen = await render(<GlobalDictationOverlay {...props({ onInsert, onCopy })} />);
    try {
      await page.getByRole("button", { name: "Insert", exact: true }).click();
      await expect.element(page.getByText(/may have reached the original app/)).toBeInTheDocument();
      await expect
        .element(page.getByText(/will not repeat the write automatically/))
        .toBeInTheDocument();
      expect(document.body.textContent).not.toContain("Nothing was inserted");
      await expect
        .element(page.getByRole("textbox", { name: "Editable draft" }))
        .toHaveValue("Hello, WORLD!");
      expect(onInsert).toHaveBeenCalledOnce();
      expect(onCopy).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("explains a changed insertion target and keeps the reviewed draft available to copy", async () => {
    const onCopy = vi.fn();
    const onInsert = vi.fn(async () => {
      throw new GlobalDictationInsertError("target_changed");
    });
    const screen = await render(<GlobalDictationOverlay {...props({ onInsert, onCopy })} />);
    try {
      const draft = page.getByRole("textbox", { name: "Editable draft" });
      await draft.fill("My reviewed draft.");
      await page.getByRole("button", { name: "Insert", exact: true }).click();
      await expect
        .element(page.getByText(/The original text or selection changed. Nothing was inserted/))
        .toBeInTheDocument();
      await expect.element(draft).toHaveValue("My reviewed draft.");
      await expect.element(page.getByRole("button", { name: "Save text…" })).toBeEnabled();
      expect(onInsert).toHaveBeenCalledExactlyOnceWith("My reviewed draft.");
      expect(onCopy).not.toHaveBeenCalled();
      await page.getByRole("button", { name: "Copy", exact: true }).click();
      expect(onCopy).toHaveBeenCalledExactlyOnceWith("My reviewed draft.");
    } finally {
      await screen.unmount();
    }
  });

  it.each([
    ["unknown native reason", new GlobalDictationInsertError("private target text and path")],
    ["unclassified exception", new Error("private target text and path")],
  ])("hides private insertion details in an %s", async (_label, error) => {
    const onInsert = vi.fn(async () => {
      throw error;
    });
    const screen = await render(<GlobalDictationOverlay {...props({ onInsert })} />);
    try {
      await page.getByRole("button", { name: "Insert", exact: true }).click();
      await expect
        .element(page.getByText(/Could not insert. Your draft is unchanged/))
        .toBeInTheDocument();
      expect(document.body.textContent).not.toContain("private target text and path");
      expect(onInsert).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  });

  it("does not claim a cancelled Save picker saved the draft", async () => {
    const onSave = vi.fn(async () => false);
    const screen = await render(<GlobalDictationOverlay {...props({ onSave })} />);
    try {
      await page.getByRole("button", { name: "Save text…" }).click();
      expect(onSave).toHaveBeenCalledOnce();
      await expect.element(page.getByText("Saved your draft.")).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("does not replace manual edits silently when a style or reset is selected", async () => {
    const screen = await render(<GlobalDictationOverlay {...props()} />);
    try {
      const draft = page.getByRole("textbox", { name: "Editable draft" });
      await draft.fill("Important manually edited text");
      await page.getByRole("button", { name: "lowercase", exact: true }).click();
      await expect.element(draft).toHaveValue("Important manually edited text");
      await expect.element(page.getByText(/replaces your manual edits/)).toBeInTheDocument();
      await page.getByRole("button", { name: "Keep edits" }).click();
      await expect.element(draft).toHaveValue("Important manually edited text");
      await page.getByRole("button", { name: "lowercase", exact: true }).click();
      await page.getByRole("button", { name: "Replace draft" }).click();
      await expect.element(draft).toHaveValue("hello, world!");
      await page.getByRole("button", { name: "no punctuation", exact: true }).click();
      await expect.element(draft).toHaveValue("Hello WORLD");
    } finally {
      await screen.unmount();
    }
  });

  it("asks before closing a nonempty review draft from either close control", async () => {
    const onCancel = vi.fn();
    const screen = await render(<GlobalDictationOverlay {...props({ onCancel })} />);
    try {
      await page.getByRole("button", { name: "Close dictation" }).click();
      expect(onCancel).not.toHaveBeenCalled();
      await expect.element(page.getByText(/Discard this draft/)).toBeInTheDocument();
      await page.getByRole("button", { name: "Keep drafting" }).click();
      await page.getByRole("button", { name: "Cancel" }).click();
      expect(onCancel).not.toHaveBeenCalled();
      await page.getByRole("button", { name: "Discard draft" }).click();
      expect(onCancel).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  });

  it("requires explicit cost/privacy consent before requesting a formal rewrite", async () => {
    const rewriteText = vi.fn(
      async (_request: DictationRewriteTextInput, _signal: AbortSignal) => "Greetings, world.",
    );
    const screen = await render(<GlobalDictationOverlay {...props({ rewriteText })} />);
    try {
      await page.getByRole("button", { name: "Formal" }).click();
      expect(rewriteText).not.toHaveBeenCalled();
      await expect.element(page.getByText(/additional API credits/)).toBeInTheDocument();
      await page.getByRole("button", { name: "Allow & rewrite" }).click();
      await expect
        .element(page.getByRole("textbox", { name: "Editable draft" }))
        .toHaveValue("Greetings, world.");
      expect(rewriteText).toHaveBeenCalledOnce();
      expect(rewriteText.mock.calls[0]?.[0]).toEqual({
        text: "Hello, WORLD!",
        style: "formal",
        consent: true,
      });
    } finally {
      await screen.unmount();
    }
  });

  it("retains the original draft and hides raw provider error text when rewriting fails", async () => {
    const rewriteText = vi.fn(async () => {
      throw new Error("private upstream response with secret text");
    });
    const screen = await render(<GlobalDictationOverlay {...props({ rewriteText })} />);
    try {
      await page.getByRole("button", { name: "Formal" }).click();
      await page.getByRole("button", { name: "Allow & rewrite" }).click();
      await expect
        .element(page.getByRole("textbox", { name: "Editable draft" }))
        .toHaveValue("Hello, WORLD!");
      await expect.element(page.getByText(/could not finish/)).toBeInTheDocument();
      expect(document.body.textContent).not.toContain("private upstream response");
    } finally {
      await screen.unmount();
    }
  });

  it("keeps a manual edit when a late formal rewrite resolves", async () => {
    const pending: { finish?: (result: string) => void } = {};
    const rewriteText = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          pending.finish = resolve;
        }),
    );
    const screen = await render(<GlobalDictationOverlay {...props({ rewriteText })} />);
    try {
      await page.getByRole("button", { name: "Formal" }).click();
      await page.getByRole("button", { name: "Allow & rewrite" }).click();
      const draft = page.getByRole("textbox", { name: "Editable draft" });
      await draft.fill("My newer manual edit");
      pending.finish?.("This late response must be discarded.");
      await expect.element(draft).toHaveValue("My newer manual edit");
    } finally {
      await screen.unmount();
    }
  });

  it("parses finalized style audio only after arming the separate command mic", async () => {
    const onStart = vi.fn();
    const onStop = vi.fn();
    const voiceCommand: GlobalDictationVoiceCommandControl = {
      phase: "idle",
      result: { id: "stale", transcript: "style formal" },
      onStart,
      onStop,
    };
    const initial = props({ voiceCommand });
    const screen = await render(<GlobalDictationOverlay {...initial} />);
    try {
      const draft = page.getByRole("textbox", { name: "Editable draft" });
      await expect.element(draft).toHaveValue("Hello, WORLD!");
      await page.getByRole("button", { name: "Start voice style command" }).click();
      expect(onStart).toHaveBeenCalledOnce();
      await expect.element(draft).toHaveValue("Hello, WORLD!");
      await screen.rerender(
        <GlobalDictationOverlay
          {...props({
            voiceCommand: {
              ...voiceCommand,
              result: { id: "new", transcript: "Style lowercase." },
            },
          })}
        />,
      );
      await expect.element(draft).toHaveValue("hello, world!");
      await expect
        .element(page.getByRole("button", { name: "Start voice style command" }))
        .toHaveAttribute("aria-pressed", "false");
    } finally {
      await screen.unmount();
    }
  });

  it("admits a manually stopped custom command exactly once after finalization", async () => {
    const pending: { finish?: () => void } = {};
    const onStop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          pending.finish = resolve;
        }),
    );
    const rewriteText = vi.fn(async () => "Must not run without approval.");
    const voiceCommand: GlobalDictationVoiceCommandControl = {
      phase: "idle",
      onStart: vi.fn(),
      onStop,
    };
    const initial = props({ voiceCommand, rewriteText });
    const screen = await render(<GlobalDictationOverlay {...initial} />);
    try {
      await page.getByRole("button", { name: "Start voice style command" }).click();
      await page.getByRole("button", { name: "Stop voice style command" }).click();
      await expect
        .element(page.getByRole("button", { name: "Finishing voice style command" }))
        .toBeDisabled();
      await screen.rerender(
        <GlobalDictationOverlay
          {...initial}
          voiceCommand={{ ...voiceCommand, phase: "finalizing" }}
        />,
      );
      expect(rewriteText).not.toHaveBeenCalled();
      await screen.rerender(
        <GlobalDictationOverlay
          {...initial}
          voiceCommand={{
            ...voiceCommand,
            result: { id: "manual-final", transcript: "style Warm and concise." },
          }}
        />,
      );
      pending.finish?.();
      await expect
        .element(page.getByRole("textbox", { name: "Custom style instructions" }))
        .toHaveValue("Warm and concise.");
      await expect
        .element(page.getByRole("button", { name: "Start voice style command" }))
        .toBeEnabled();
      expect(onStop).toHaveBeenCalledOnce();
      expect(rewriteText).not.toHaveBeenCalled();
      expect(initial.onInsert).not.toHaveBeenCalled();
      expect(initial.onCopy).not.toHaveBeenCalled();
      expect(initial.onSave).not.toHaveBeenCalled();
    } finally {
      pending.finish?.();
      await screen.unmount();
    }
  });

  it.each(["start", "stop"] as const)(
    "disarms after command %s fails and ignores a late result",
    async (failureAt) => {
      const fail = vi.fn(async () => {
        throw new Error("private capture failure");
      });
      const voiceCommand: GlobalDictationVoiceCommandControl = {
        phase: "idle",
        onStart: failureAt === "start" ? fail : vi.fn(),
        onStop: failureAt === "stop" ? fail : vi.fn(),
      };
      const screen = await render(<GlobalDictationOverlay {...props({ voiceCommand })} />);
      try {
        await page.getByRole("button", { name: "Start voice style command" }).click();
        if (failureAt === "stop")
          await page.getByRole("button", { name: "Stop voice style command" }).click();
        await expect
          .element(page.getByText(/command microphone could not finish/))
          .toBeInTheDocument();
        await expect
          .element(page.getByRole("button", { name: "Start voice style command" }))
          .toHaveAttribute("aria-pressed", "false");
        await screen.rerender(
          <GlobalDictationOverlay
            {...props({
              voiceCommand: {
                ...voiceCommand,
                result: { id: "late-failed", transcript: "style lowercase" },
              },
            })}
          />,
        );
        await expect
          .element(page.getByRole("textbox", { name: "Editable draft" }))
          .toHaveValue("Hello, WORLD!");
        expect(document.body.textContent).not.toContain("private capture failure");
      } finally {
        await screen.unmount();
      }
    },
  );

  it.each(["Copy", "Save text…", "Insert"])(
    "fences a late custom rewrite when %s exports the reviewed draft",
    async (button) => {
      const pending: { rewrite?: (value: string) => void; action?: () => void } = {};
      const action = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            pending.action = resolve;
          }),
      );
      const rewriteText = vi.fn(
        (_request: DictationRewriteTextInput, _signal: AbortSignal) =>
          new Promise<string>((resolve) => {
            pending.rewrite = resolve;
          }),
      );
      const screen = await render(
        <GlobalDictationOverlay
          {...props({ rewriteText, onCopy: action, onSave: action, onInsert: action })}
        />,
      );
      try {
        await page.getByRole("button", { name: "Custom", exact: true }).click();
        await page.getByRole("textbox", { name: "Custom style instructions" }).fill("Warm.");
        await page.getByRole("button", { name: "Apply custom style" }).click();
        await page.getByRole("button", { name: "Allow & rewrite" }).click();
        await page.getByRole("button", { name: button, exact: true }).click();
        expect(action).toHaveBeenCalledExactlyOnceWith("Hello, WORLD!");
        expect(rewriteText.mock.calls[0]?.[1].aborted).toBe(true);
        await expect
          .element(page.getByRole("button", { name: "Formal", exact: true }))
          .toBeDisabled();
        await expect
          .element(page.getByRole("button", { name: "Apply custom style" }))
          .toBeDisabled();
        pending.rewrite?.("A stale rewrite that was never exported.");
        await expect
          .element(page.getByRole("textbox", { name: "Editable draft" }))
          .toHaveValue("Hello, WORLD!");
        pending.action?.();
        await expect
          .element(page.getByRole("button", { name: "Formal", exact: true }))
          .toBeEnabled();
      } finally {
        pending.rewrite?.("Ignored after unmount.");
        pending.action?.();
        await screen.unmount();
      }
    },
  );

  it.each(["Copy", "Save text…", "Insert"])(
    "revokes pending custom consent when %s exports the draft",
    async (button) => {
      const action = vi.fn();
      const rewriteText = vi.fn(async () => "Must not run.");
      const screen = await render(
        <GlobalDictationOverlay
          {...props({ rewriteText, onCopy: action, onSave: action, onInsert: action })}
        />,
      );
      try {
        await page.getByRole("button", { name: "Custom", exact: true }).click();
        await page.getByRole("textbox", { name: "Custom style instructions" }).fill("Warm.");
        await page.getByRole("button", { name: "Apply custom style" }).click();
        await expect
          .element(page.getByRole("button", { name: "Allow & rewrite" }))
          .toBeInTheDocument();
        await page.getByRole("button", { name: button, exact: true }).click();
        await expect
          .element(page.getByRole("button", { name: "Allow & rewrite" }))
          .not.toBeInTheDocument();
        expect(action).toHaveBeenCalledExactlyOnceWith("Hello, WORLD!");
        expect(rewriteText).not.toHaveBeenCalled();
      } finally {
        await screen.unmount();
      }
    },
  );

  it("disarms a spoken style before exporting and ignores its late result", async () => {
    const voiceCommand: GlobalDictationVoiceCommandControl = {
      phase: "idle",
      onStart: vi.fn(),
      onStop: vi.fn(),
    };
    const rewriteText = vi.fn(async () => "Must not run.");
    const initial = props({ voiceCommand, rewriteText, formalConsentGranted: true });
    const screen = await render(<GlobalDictationOverlay {...initial} />);
    try {
      await page.getByRole("button", { name: "Start voice style command" }).click();
      await page.getByRole("button", { name: "Copy", exact: true }).click();
      await screen.rerender(
        <GlobalDictationOverlay
          {...initial}
          voiceCommand={{ ...voiceCommand, phase: "finalizing" }}
        />,
      );
      await expect
        .element(page.getByRole("button", { name: "Start voice style command" }))
        .toBeDisabled();
      await screen.rerender(
        <GlobalDictationOverlay
          {...initial}
          voiceCommand={{
            ...voiceCommand,
            result: { id: "late-export", transcript: "style formal" },
          }}
        />,
      );
      expect(voiceCommand.onStop).toHaveBeenCalledOnce();
      expect(initial.onCopy).toHaveBeenCalledExactlyOnceWith("Hello, WORLD!");
      expect(rewriteText).not.toHaveBeenCalled();
      await expect
        .element(page.getByRole("textbox", { name: "Editable draft" }))
        .toHaveValue("Hello, WORLD!");
    } finally {
      await screen.unmount();
    }
  });

  it("ignores a previous command's late start failure after a new command is armed", async () => {
    const pending: { fail?: (error: Error) => void } = {};
    const onStart = vi.fn<() => void | Promise<void>>().mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          pending.fail = reject;
        }),
    );
    const voiceCommand: GlobalDictationVoiceCommandControl = {
      phase: "idle",
      onStart,
      onStop: vi.fn(),
    };
    const initial = props({ voiceCommand });
    const screen = await render(<GlobalDictationOverlay {...initial} />);
    try {
      await page.getByRole("button", { name: "Start voice style command" }).click();
      await screen.rerender(
        <GlobalDictationOverlay
          {...initial}
          voiceCommand={{
            ...voiceCommand,
            result: { id: "first-final", transcript: "cancel command" },
          }}
        />,
      );
      await page.getByRole("button", { name: "Start voice style command" }).click();
      pending.fail?.(new Error("obsolete start failure"));
      await expect
        .element(page.getByRole("button", { name: "Stop voice style command" }))
        .toHaveAttribute("aria-pressed", "true");
      await screen.rerender(
        <GlobalDictationOverlay
          {...initial}
          voiceCommand={{
            ...voiceCommand,
            result: { id: "second-final", transcript: "style lowercase" },
          }}
        />,
      );
      await expect
        .element(page.getByRole("textbox", { name: "Editable draft" }))
        .toHaveValue("hello, world!");
      expect(document.body.textContent).not.toContain("could not finish");
    } finally {
      pending.fail?.(new Error("cancelled test"));
      await screen.unmount();
    }
  });

  it("reviews a spoken custom style before Apply and separate privacy consent", async () => {
    const rewriteText = vi.fn(
      async (_request: DictationRewriteTextInput, _signal: AbortSignal) => "A warm, concise draft.",
    );
    const onInsert = vi.fn();
    const onCopy = vi.fn();
    const onSave = vi.fn();
    const voiceCommand: GlobalDictationVoiceCommandControl = {
      phase: "idle",
      onStart: vi.fn(),
      onStop: vi.fn(),
      result: { id: "stale-custom", transcript: "style old instructions" },
    };
    const initial = props({
      rewriteText,
      formalConsentGranted: true,
      voiceCommand,
      onInsert,
      onCopy,
      onSave,
    });
    const screen = await render(<GlobalDictationOverlay {...initial} />);
    try {
      await expect
        .element(page.getByRole("textbox", { name: "Custom style instructions" }))
        .not.toBeInTheDocument();
      await page.getByRole("button", { name: "Start voice style command" }).click();
      await screen.rerender(
        <GlobalDictationOverlay
          {...initial}
          voiceCommand={{
            ...voiceCommand,
            result: {
              id: "fresh-custom",
              transcript: "Style Warm and concise. Keep NASA uppercase.",
            },
          }}
        />,
      );
      await expect
        .element(page.getByRole("textbox", { name: "Custom style instructions" }))
        .toHaveValue("Warm and concise. Keep NASA uppercase.");
      await expect
        .element(page.getByRole("textbox", { name: "Editable draft" }))
        .toHaveValue("Hello, WORLD!");
      expect(rewriteText).not.toHaveBeenCalled();
      expect(onInsert).not.toHaveBeenCalled();
      expect(onCopy).not.toHaveBeenCalled();
      expect(onSave).not.toHaveBeenCalled();
      await page.getByRole("button", { name: "Apply custom style" }).click();
      expect(rewriteText).not.toHaveBeenCalled();
      await expect
        .element(page.getByText(/original transcript and your style instructions to OpenAI/))
        .toBeInTheDocument();
      await page.getByRole("button", { name: "Allow & rewrite" }).click();
      await expect
        .element(page.getByRole("textbox", { name: "Editable draft" }))
        .toHaveValue("A warm, concise draft.");
      expect(rewriteText).toHaveBeenCalledExactlyOnceWith(
        {
          text: "Hello, WORLD!",
          style: "custom",
          instructions: "Warm and concise. Keep NASA uppercase.",
          consent: true,
        },
        expect.any(AbortSignal),
      );
      expect(onInsert).not.toHaveBeenCalled();
      expect(onCopy).not.toHaveBeenCalled();
      expect(onSave).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("confirms replacement of manual edits and rewrites from the immutable original", async () => {
    const rewriteText = vi.fn(
      async (_request: DictationRewriteTextInput, _signal: AbortSignal) => "A custom draft.",
    );
    const initial = props({ rewriteText });
    const screen = await render(<GlobalDictationOverlay {...initial} />);
    try {
      await page.getByRole("textbox", { name: "Editable draft" }).fill("My manual revision");
      await screen.rerender(
        <GlobalDictationOverlay {...initial} transcript="A late transcript must be ignored" />,
      );
      await page.getByRole("button", { name: "Custom", exact: true }).click();
      const instructions = page.getByRole("textbox", { name: "Custom style instructions" });
      await expect
        .element(instructions)
        .toHaveAttribute("maxlength", String(DICTATION_REWRITE_INSTRUCTIONS_MAX_CHARS));
      await expect.element(page.getByRole("button", { name: "Apply custom style" })).toBeDisabled();
      await instructions.fill("Keep it short.");
      await page.getByRole("button", { name: "Apply custom style" }).click();
      await expect.element(page.getByText(/replaces your manual edits/)).toBeInTheDocument();
      expect(rewriteText).not.toHaveBeenCalled();
      await page.getByRole("button", { name: "Keep edits" }).click();
      await expect
        .element(page.getByRole("textbox", { name: "Editable draft" }))
        .toHaveValue("My manual revision");
      await page.getByRole("button", { name: "Apply custom style" }).click();
      await page.getByRole("button", { name: "Replace draft" }).click();
      expect(rewriteText).not.toHaveBeenCalled();
      await page.getByRole("button", { name: "Allow & rewrite" }).click();
      await expect
        .element(page.getByRole("textbox", { name: "Editable draft" }))
        .toHaveValue("A custom draft.");
      expect(rewriteText).toHaveBeenCalledExactlyOnceWith(
        { text: "Hello, WORLD!", style: "custom", instructions: "Keep it short.", consent: true },
        expect.any(AbortSignal),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("revokes old consent and ignores a late custom rewrite after instructions change", async () => {
    const completions: Array<(result: string) => void> = [];
    const rewriteText = vi.fn(
      (_request: DictationRewriteTextInput, _signal: AbortSignal) =>
        new Promise<string>((resolve) => completions.push(resolve)),
    );
    const screen = await render(<GlobalDictationOverlay {...props({ rewriteText })} />);
    try {
      await page.getByRole("button", { name: "Custom", exact: true }).click();
      const instructions = page.getByRole("textbox", { name: "Custom style instructions" });
      await instructions.fill("Warm.");
      await page.getByRole("button", { name: "Apply custom style" }).click();
      await instructions.fill("Concise.");
      await expect
        .element(page.getByRole("button", { name: "Allow & rewrite" }))
        .not.toBeInTheDocument();
      expect(rewriteText).not.toHaveBeenCalled();
      await page.getByRole("button", { name: "Apply custom style" }).click();
      await page.getByRole("button", { name: "Allow & rewrite" }).click();
      await instructions.fill("Friendly.");
      expect(rewriteText.mock.calls[0]?.[1].aborted).toBe(true);
      await page.getByRole("button", { name: "Apply custom style" }).click();
      await page.getByRole("button", { name: "Allow & rewrite" }).click();
      completions[1]?.("The newer friendly draft.");
      await expect
        .element(page.getByRole("textbox", { name: "Editable draft" }))
        .toHaveValue("The newer friendly draft.");
      completions[0]?.("An obsolete concise draft.");
      await expect
        .element(page.getByRole("textbox", { name: "Editable draft" }))
        .toHaveValue("The newer friendly draft.");
      expect(rewriteText).toHaveBeenCalledTimes(2);
    } finally {
      await screen.unmount();
    }
  });

  it("does not let a previous session's custom rewrite replace the new draft", async () => {
    const pending: { finish?: (result: string) => void } = {};
    const rewriteText = vi.fn(
      (_request: DictationRewriteTextInput, _signal: AbortSignal) =>
        new Promise<string>((resolve) => {
          pending.finish = resolve;
        }),
    );
    const screen = await render(<GlobalDictationOverlay {...props({ rewriteText })} />);
    try {
      await page.getByRole("button", { name: "Custom", exact: true }).click();
      await page.getByRole("textbox", { name: "Custom style instructions" }).fill("A warm style.");
      await page.getByRole("button", { name: "Apply custom style" }).click();
      await page.getByRole("button", { name: "Allow & rewrite" }).click();
      await screen.rerender(
        <GlobalDictationOverlay
          {...props({ rewriteText, sessionId: "session-two", transcript: "A new original." })}
        />,
      );
      expect(rewriteText.mock.calls[0]?.[1].aborted).toBe(true);
      pending.finish?.("Old session response.");
      await expect
        .element(page.getByRole("textbox", { name: "Editable draft" }))
        .toHaveValue("A new original.");
      await expect
        .element(page.getByRole("textbox", { name: "Custom style instructions" }))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it.each(["insert", "paste", "copy", "save", "submit", "style lowercase and insert"])(
    "rejects the spoken action %s and never invokes an external action",
    async (transcript) => {
      const onInsert = vi.fn();
      const onCopy = vi.fn();
      const onSave = vi.fn();
      const rewriteText = vi.fn(async () => "Unwanted rewrite");
      const onStart = vi.fn();
      const voiceCommand: GlobalDictationVoiceCommandControl = {
        phase: "idle",
        onStart,
        onStop: vi.fn(),
      };
      const screen = await render(
        <GlobalDictationOverlay
          {...props({ voiceCommand, onInsert, onCopy, onSave, rewriteText })}
        />,
      );
      try {
        await page.getByRole("button", { name: "Start voice style command" }).click();
        await screen.rerender(
          <GlobalDictationOverlay
            {...props({
              voiceCommand: { ...voiceCommand, result: { id: "unsafe", transcript } },
              onInsert,
              onCopy,
              onSave,
              rewriteText,
            })}
          />,
        );
        await expect.element(page.getByText(/Command not recognized/)).toBeInTheDocument();
        expect(onInsert).not.toHaveBeenCalled();
        expect(onCopy).not.toHaveBeenCalled();
        expect(onSave).not.toHaveBeenCalled();
        expect(rewriteText).not.toHaveBeenCalled();
      } finally {
        await screen.unmount();
      }
    },
  );

  it("asks before replacing manually edited text through a spoken style command", async () => {
    const voiceCommand: GlobalDictationVoiceCommandControl = {
      phase: "idle",
      onStart: vi.fn(),
      onStop: vi.fn(),
    };
    const screen = await render(<GlobalDictationOverlay {...props({ voiceCommand })} />);
    try {
      const draft = page.getByRole("textbox", { name: "Editable draft" });
      await draft.fill("Leave my typed words alone");
      await page.getByRole("button", { name: "Start voice style command" }).click();
      await screen.rerender(
        <GlobalDictationOverlay
          {...props({
            voiceCommand: {
              ...voiceCommand,
              result: { id: "spoken-style", transcript: "style lowercase" },
            },
          })}
        />,
      );
      await expect.element(draft).toHaveValue("Leave my typed words alone");
      await expect.element(page.getByRole("button", { name: "Keep edits" })).toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});
