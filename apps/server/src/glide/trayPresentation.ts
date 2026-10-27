import { uiText, type UiLocale } from "@cafecode/shared/i18n";
import type { GlideTraySnapshot } from "./activity.ts";

export function glideTrayPresentation(
  snapshot: GlideTraySnapshot,
  presentation: { theme?: "dark" | "light"; locale: UiLocale; accent?: string },
) {
  const { locale } = presentation;
  const count = new Set(snapshot.rows.map((row) => row.owner)).size;
  return {
    ...snapshot,
    ...presentation,
    accessSummary: uiText(
      "{count, plural, one {# active chat} other {# active chats}}",
      { count },
      undefined,
      locale,
    ),
    labels: {
      title: uiText("Computer use", undefined, undefined, locale),
      about: uiText("About this list", undefined, undefined, locale),
      settings: uiText("Computer use settings", undefined, undefined, locale),
      explanation: uiText(
        "Screenshots are taken only when a chat asks. Each preview is the last one Cafe actually received, with its time.",
        undefined,
        undefined,
        locale,
      ),
      unavailable: uiText("Status unavailable", undefined, undefined, locale),
      unconfirmed: uiText("Stop has not been confirmed.", undefined, undefined, locale),
      off: uiText("Off in every chat", undefined, undefined, locale),
      empty: uiText("Computer use is off", undefined, undefined, locale),
      emptyHint: uiText(
        "No screenshots, text reading or input in any chat.",
        undefined,
        undefined,
        locale,
      ),
      noScreenshot: uiText("No screenshot yet", undefined, undefined, locale),
      ready: uiText("Ready", undefined, undefined, locale),
      unused: uiText("Ready · not used yet", undefined, undefined, locale),
      capturing: uiText("Capturing", undefined, undefined, locale),
      reading: uiText("Reading text", undefined, undefined, locale),
      acting: uiText("Controlling", undefined, undefined, locale),
      stopping: uiText("Stopping…", undefined, undefined, locale),
      stop: uiText("Stop all", undefined, undefined, locale),
      stopped: uiText("All computer use stopped", undefined, undefined, locale),
      waiting: uiText("Stop requested · waiting for this Mac", undefined, undefined, locale),
      stopHint: uiText(
        "Stays off until you turn it on again in a chat.",
        undefined,
        undefined,
        locale,
      ),
      offHint: uiText("Turn it on again from a chat’s composer.", undefined, undefined, locale),
      stoppingHint: uiText(
        "Blocking new actions, then cancelling active ones.",
        undefined,
        undefined,
        locale,
      ),
      unknownHint: uiText(
        "Not confirmed yet. It will apply when Cafe reconnects.",
        undefined,
        undefined,
        locale,
      ),
      open: uiText("Open chat", undefined, undefined, locale),
      stopChat: uiText("Stop for this chat", undefined, undefined, locale),
      nothing: uiText("nothing running", undefined, undefined, locale),
    },
  };
}
