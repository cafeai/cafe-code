import type { DesktopBridge, GlobalDictationEvent } from "@cafecode/contracts";
import { setUiLocale, uiText } from "@cafecode/shared/i18n";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const capture = vi.hoisted(() => ({
  cancel: vi.fn(),
  finalize: vi.fn(async () => undefined),
  start: vi.fn(),
  wait: vi.fn(async () => undefined),
}));
vi.mock("~/dictation/realtimeTranscription", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/dictation/realtimeTranscription")>()),
  startRealtimeTranscription: capture.start,
}));
vi.mock("~/globalDictation/waitForEnvironment", () => ({
  waitForDictationEnvironmentReady: capture.wait,
}));
vi.mock("~/environments/runtime", () => ({
  getPrimaryEnvironmentConnection: () => ({
    client: { dictation: { createClientSecret: vi.fn() } },
  }),
}));
import { GlobalDictationApp } from "~/globalDictation/entry";

describe("global dictation language lifetime", () => {
  it("updates captured native guidance without retiring capture, re-subscribing, or replaying ready", async () => {
    setUiLocale("en");
    const originalBridge = window.desktopBridge;
    const originalTitle = document.title;
    let listener: ((event: GlobalDictationEvent) => void) | undefined;
    const unsubscribe = vi.fn();
    const onEvent = vi.fn((value: (event: GlobalDictationEvent) => void) => {
      listener = value;
      return unsubscribe;
    });
    const action = vi.fn(async () => ({ ok: true }));
    capture.cancel.mockReset();
    capture.start
      .mockReset()
      .mockResolvedValue({ cancel: capture.cancel, stopAndFinalize: capture.finalize });
    window.desktopBridge = {
      onGlobalDictationEvent: onEvent,
      globalDictationAction: action,
    } as unknown as DesktopBridge;
    const screen = await render(<GlobalDictationApp />);
    try {
      await vi.waitFor(() => expect(onEvent).toHaveBeenCalledOnce());
      listener!({
        type: "start",
        sessionId: "synthetic-capture",
        insertAvailable: false,
        guidance: "accessibility_permission_required",
        reason: "Old sender fallback remains opaque.",
      });
      await vi.waitFor(() => expect(capture.start).toHaveBeenCalledOnce());
      const input = capture.start.mock.calls[0]![0] as { signal: AbortSignal };
      await expect
        .element(
          page.getByText(
            uiText(
              "To enable Insert, allow Cafe Code Accessibility in macOS System Settings. You can still Copy or Save.",
            ),
            { exact: true },
          ),
        )
        .toBeInTheDocument();
      for (const locale of ["ja", "ko"] as const) {
        setUiLocale(locale);
        await expect
          .element(
            page.getByText(
              uiText(
                "To enable Insert, allow Cafe Code Accessibility in macOS System Settings. You can still Copy or Save.",
                undefined,
                undefined,
                locale,
              ),
              { exact: true },
            ),
          )
          .toBeInTheDocument();
        expect(document.title).toBe(uiText("Cafe Dictation", undefined, undefined, locale));
        expect(input.signal.aborted).toBe(false);
        expect(capture.cancel).not.toHaveBeenCalled();
        expect(capture.start).toHaveBeenCalledOnce();
        expect(onEvent).toHaveBeenCalledOnce();
        expect(unsubscribe).not.toHaveBeenCalled();
        expect(action).toHaveBeenCalledOnce();
      }
    } finally {
      await screen.unmount();
      expect(capture.cancel).toHaveBeenCalledOnce();
      expect(unsubscribe).toHaveBeenCalledOnce();
      if (originalBridge === undefined) delete window.desktopBridge;
      else window.desktopBridge = originalBridge;
      document.title = originalTitle;
      setUiLocale("en");
    }
  });
});
