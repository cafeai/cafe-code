import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GlobalDictationInsertError,
  globalDictationStatusFromEvent,
  formatGlobalDictationStatus,
} from "./GlobalDictationOverlay";
import { uiText } from "@cafecode/shared/i18n";

afterEach(() => {
  vi.doUnmock("@cafecode/shared/i18n");
  vi.resetModules();
});

describe("GlobalDictationInsertError presentation", () => {
  it("retains only finite native guidance while rendering current language and preserving legacy text", () => {
    const status = globalDictationStatusFromEvent({
      guidance: "accessibility_permission_required",
      reason: "legacy received reason",
    });
    expect(status).toEqual({ kind: "guidance", code: "accessibility_permission_required" });
    for (const locale of ["en", "ja", "ko"] as const) {
      expect(formatGlobalDictationStatus(status!, locale)).toBe(
        uiText(
          "To enable Insert, allow Cafe Code Accessibility in macOS System Settings. You can still Copy or Save.",
          undefined,
          undefined,
          locale,
        ),
      );
    }
    const legacy = globalDictationStatusFromEvent({
      reason: "Unchanged received {private} reason.",
    });
    expect(formatGlobalDictationStatus(legacy!, "ja")).toBe("Unchanged received {private} reason.");
    expect(
      globalDictationStatusFromEvent({ guidance: "private path" as "target_unavailable" }),
    ).toBeUndefined();
    const error = new GlobalDictationInsertError("target_changed");
    const diagnostic = error.message;
    expect(error.displayMessage("ja")).toBe(
      uiText(
        "The original text or selection changed. Nothing was inserted.",
        undefined,
        undefined,
        "ja",
      ),
    );
    expect(error.displayMessage("ko")).toBe(
      uiText(
        "The original text or selection changed. Nothing was inserted.",
        undefined,
        undefined,
        "ko",
      ),
    );
    expect(error.message).toBe(diagnostic);
    expect(error.presentationCode).toBe("target_changed");
    expect(error).not.toHaveProperty("retry");
  });
  it.each([
    ["target_changed", "The original text or selection changed. Nothing was inserted."],
    [
      "target_unavailable",
      "The original app or text field is no longer open. Nothing was inserted.",
    ],
    ["target_unsupported", "That text field doesn't accept inserted text. Nothing was inserted."],
    [
      "accessibility_permission_required",
      "Allow Cafe in System Settings → Privacy & Security → Accessibility, then try again. Nothing was inserted.",
    ],
    ["clipboard_unavailable", "Cafe could not prepare the clipboard. Nothing was pasted."],
    [
      "insertion_uncertain",
      "Insert may have reached the original app. Check that field before trying again; Cafe will not repeat the write automatically.",
    ],
  ])("keeps the exact English guidance for %s and its class identity", (reason, message) => {
    const error = new GlobalDictationInsertError(reason);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(GlobalDictationInsertError);
    expect(error.name).toBe("GlobalDictationInsertError");
    expect(error.message).toBe(message);
  });

  it("keeps paste uncertainty separate without authorizing an automatic replay", () => {
    const error = new GlobalDictationInsertError("insertion_uncertain", "paste");
    expect(error.message).toBe(
      "Your draft may have been pasted. Check the field before trying again; Cafe will not repeat the paste automatically. The draft may remain on the clipboard.",
    );
    expect(error.name).toBe("GlobalDictationInsertError");
    expect(error).not.toHaveProperty("retry");
    expect(error).not.toHaveProperty("insertAvailable");
  });

  it("never stores or interpolates unrecognized private native reason data", () => {
    for (const reason of [
      "private target {value} /secret/path <img>",
      {
        toString() {
          throw new Error("Private target must not be coerced");
        },
      },
    ]) {
      const error = new GlobalDictationInsertError(reason);
      expect(error.message).toBe("Could not insert. Your draft is unchanged.");
      expect(error).not.toHaveProperty("reason");
      expect(error).not.toHaveProperty("cause");
    }
  });

  it("localizes finite guidance without changing reason matching, name or receipt authority", async () => {
    vi.doMock("@cafecode/shared/i18n", async (importOriginal) => {
      const original = await importOriginal<typeof import("@cafecode/shared/i18n")>();
      const translator = original.createUiTranslator({
        catalog: {
          "The original text or selection changed. Nothing was inserted.":
            "Localized target guidance.",
        },
      });
      return { ...original, uiText: translator.text };
    });
    const { GlobalDictationInsertError: LocalizedInsertError } =
      await import("./GlobalDictationOverlay");
    const error = new LocalizedInsertError("target_changed", "paste");
    expect(error.message).toBe("Localized target guidance.");
    expect(error.name).toBe("GlobalDictationInsertError");
    expect(error).toBeInstanceOf(LocalizedInsertError);
    expect(error).not.toHaveProperty("insertAvailable");
    expect(new LocalizedInsertError("localized_target_changed").message).toBe(
      "Could not insert. Your draft is unchanged.",
    );
  });
});
