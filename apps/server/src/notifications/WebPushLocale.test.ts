import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { getUiLocale, getUiTranslator, setUiLocale } from "@cafecode/shared/i18n";
import {
  WebPushSubscriptionInput,
  webPushCompletionBody,
  withWebPushSubscriptionLocale,
} from "./WebPushNotifications.ts";

const owner = {
  endpoint: "https://push.example/one",
  keys: { p256dh: "key-one", auth: "auth-one" },
  label: "Opaque device",
  createdAt: "2026-10-11T00:00:00Z",
};
describe("recipient-scoped Web Push locale", () => {
  it.each(["en", "ja", "ko"] as const)("formats %s independently of server state", (locale) => {
    const original = getUiLocale();
    try {
      setUiLocale("ko");
      expect(webPushCompletionBody(locale)).toBe(getUiTranslator(locale).text("Finished running"));
      expect(webPushCompletionBody(undefined)).toBe("Finished running");
      expect(getUiLocale()).toBe("ko");
    } finally {
      setUiLocale(original);
    }
  });
  it("preserves ownership/opaque metadata and cannot resurrect a removed endpoint", () => {
    const sibling = { ...owner, endpoint: "https://push.example/two" };
    const result = withWebPushSubscriptionLocale([owner, sibling], { ...owner, uiLocale: "ja" });
    expect(result).toEqual([{ ...owner, uiLocale: "ja" }, sibling]);
    expect(result[1]).toBe(sibling);
    expect(owner).not.toHaveProperty("uiLocale");
    expect(withWebPushSubscriptionLocale([], { ...owner, uiLocale: "ko" })).toEqual([]);
    for (const input of [
      { ...owner, keys: { ...owner.keys, auth: "foreign" }, uiLocale: "ko" as const },
      { ...owner, keys: { ...owner.keys, p256dh: "foreign" }, uiLocale: "ko" as const },
    ]) {
      expect(withWebPushSubscriptionLocale([owner], input)).toEqual([owner]);
    }
  });
  it("strictly admits finite optional locales, retaining English-compatible legacy records", () => {
    const decode = Schema.decodeUnknownSync(WebPushSubscriptionInput);
    expect(decode(owner)).not.toHaveProperty("uiLocale");
    for (const uiLocale of ["en", "ja", "ko"])
      expect(decode({ ...owner, uiLocale }).uiLocale).toBe(uiLocale);
    for (const uiLocale of ["system", "ja-JP", {}, null, "../../secret"])
      expect(() => decode({ ...owner, uiLocale })).toThrow();
  });
});
