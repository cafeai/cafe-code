import { afterEach, describe, expect, it, vi } from "vitest";
import * as i18n from "@cafecode/shared/i18n";
import { nativeControlDetailForUi } from "./nativeControlPresentation.ts";

afterEach(() => vi.restoreAllMocks());

describe("native control presentation boundary", () => {
  it("keeps current English copy, including literal apostrophes", () => {
    for (const detail of [
      "Enable local desktop control to connect Codex and Claude.",
      "Local control is ready. Start a new Codex or Claude session, or normally stop/resume an existing one, to attach desktop tools.",
      "Could not start the reviewed Cua runtime. Prepare it, then check native permissions and try again.",
      "Local desktop control is off.",
      "Native controller cleanup remains incomplete. Restart Cafe before using desktop control.",
      "Native cleanup could not be acknowledged. The controller was stopped; no input was replayed.",
      "The native action's completion is uncertain. The controller was stopped; inspect the desktop before retrying.",
      "Desktop input lost its response. The controller was stopped; inspect the desktop before retrying.",
    ])
      expect(nativeControlDetailForUi(detail)).toBe(detail);
  });

  it("translates only recognized UI status and passes unknown evidence through unchanged", () => {
    const text = vi.spyOn(i18n, "uiText").mockReturnValue("Isolated translated status");
    expect(nativeControlDetailForUi("Local desktop control is off.")).toBe(
      "Isolated translated status",
    );
    expect(text).toHaveBeenCalledExactlyOnceWith("Local desktop control is off.");
    text.mockClear();
    const received = "Provider detail {privatePath}: <code>keep bytes</code>";
    expect(nativeControlDetailForUi(received)).toBe(received);
    expect(text).not.toHaveBeenCalled();
  });
});
