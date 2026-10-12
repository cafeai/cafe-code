import { afterEach, describe, expect, it } from "vitest";
import { getUiLocale, setUiLocale, uiText } from "@cafecode/shared/i18n";

import {
  createQueuedFollowUpFeedback,
  formatQueuedFollowUpFeedback,
  type QueuedFollowUpFeedbackInput,
} from "./queuedFollowUpFeedback";

afterEach(() => setUiLocale("en"));

const fixedCases: readonly [QueuedFollowUpFeedbackInput, string][] = [
  [
    { code: "stopped-before-send" },
    "Stopped before sending. Select this queued message to send it.",
  ],
  [
    { code: "delivery-unknown" },
    "Delivery status is unknown. Inspect the timeline before removing this queued message.",
  ],
  [
    { code: "delivery-paused" },
    "Delivery paused. Your message and attachments are preserved. You can retry delivery.",
  ],
  [
    { code: "claimed-after-reload" },
    "Delivery status is unknown after reload. Inspect the timeline before removing this queued message.",
  ],
  [{ code: "review-before-send" }, "Review this queued follow-up before sending."],
];

describe("queued follow-up feedback provenance", () => {
  it("retains canonical English while explicit display language switches for all fixed codes", () => {
    setUiLocale("ja");
    for (const [input, english] of fixedCases) {
      const state = createQueuedFollowUpFeedback(input);
      expect(state.blockedReason).toBe(english);
      expect(Object.isFrozen(state.blockedFeedback)).toBe(true);
      for (const locale of ["en", "ja", "ko"] as const) {
        const display = formatQueuedFollowUpFeedback(
          state.blockedReason,
          state.blockedFeedback,
          locale,
        );
        expect(display).toBe(uiText(english, undefined, undefined, locale));
        if (locale !== "en") expect(display).not.toBe(english);
        expect(state.blockedReason).toBe(english);
      }
      expect(getUiLocale(), "explicit rendering never mutates process language").toBe("ja");
    }
  });

  it("keeps complete singular/plural English and the exact captured attachment count", () => {
    const source =
      "{count} {count, plural, one {attachment} other {attachments}} could not be restored after reconnecting. Remove this retry and resend the missing {count, plural, one {attachment} other {attachments}}.";
    for (const count of [1, 2, 8, 16]) {
      const input = { code: "missing-attachments" as const, count };
      const state = createQueuedFollowUpFeedback(input);
      expect(state.blockedReason).toBe(
        `${count} ${count === 1 ? "attachment" : "attachments"} could not be restored after reconnecting. Remove this retry and resend the missing ${count === 1 ? "attachment" : "attachments"}.`,
      );
      input.count = 999;
      for (const locale of ["en", "ja", "ko"] as const) {
        expect(
          formatQueuedFollowUpFeedback(state.blockedReason, state.blockedFeedback, locale),
        ).toBe(uiText(source, { count }, undefined, locale));
      }
    }
  });

  it("leaves old/raw text and an exact reason with forged, copied or serialized tokens opaque", () => {
    const state = createQueuedFollowUpFeedback({ code: "delivery-unknown" });
    const untrustedTokens = [
      undefined,
      null,
      5,
      "token",
      {},
      { code: "delivery-unknown" },
      { ...state.blockedFeedback },
      JSON.parse(JSON.stringify(state.blockedFeedback)),
      Object.create(state.blockedFeedback),
    ];
    for (const token of untrustedTokens) {
      expect(formatQueuedFollowUpFeedback(state.blockedReason, token, "ja")).toBe(
        state.blockedReason,
      );
      expect(
        formatQueuedFollowUpFeedback("<provider>原文 {} unchanged</provider>", token, "ko"),
      ).toBe("<provider>原文 {} unchanged</provider>");
    }
    expect(formatQueuedFollowUpFeedback(null, state.blockedFeedback, "ja")).toBeNull();
  });

  it("does not translate a replaced reason or a token minted for a different source", () => {
    const old = createQueuedFollowUpFeedback({ code: "delivery-paused" });
    const replacement = createQueuedFollowUpFeedback({ code: "stopped-before-send" });
    expect(formatQueuedFollowUpFeedback(replacement.blockedReason, old.blockedFeedback, "ja")).toBe(
      replacement.blockedReason,
    );
    expect(formatQueuedFollowUpFeedback(`${old.blockedReason} `, old.blockedFeedback, "ko")).toBe(
      `${old.blockedReason} `,
    );
    expect(
      formatQueuedFollowUpFeedback(replacement.blockedReason, replacement.blockedFeedback, "ko"),
    ).not.toBe(replacement.blockedReason);
  });

  it("rejects nonfinite, unsafe, fractional and nonpositive attachment counts before minting", () => {
    for (const count of [0, -1, 1.25, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => createQueuedFollowUpFeedback({ code: "missing-attachments", count })).toThrow(
        RangeError,
      );
    }
    expect(() =>
      createQueuedFollowUpFeedback({ code: "unknown" } as unknown as QueuedFollowUpFeedbackInput),
    ).toThrow(TypeError);
  });
});
