import { describe, expect, it } from "vitest";

import { isNewerRenewalOfSameCodexLogin } from "./codexAuthJson.ts";
import { codexLoginFixture } from "./testUtils/codexLoginFixture.ts";

describe("isNewerRenewalOfSameCodexLogin", () => {
  const consumed = codexLoginFixture({
    refreshToken: "rt-old",
    lastRefresh: "2026-10-25T18:43:53Z",
  });
  const renewed = codexLoginFixture({
    refreshToken: "rt-new",
    lastRefresh: "2026-11-04T19:00:00Z",
  });

  it("accepts a strictly newer rotated renewal of the same user and account", () => {
    expect(isNewerRenewalOfSameCodexLogin(renewed, consumed)).toBe(true);
    expect(isNewerRenewalOfSameCodexLogin(consumed, renewed)).toBe(false);
  });

  it("never prefers a different user, account, or unrotated copy", () => {
    const otherUser = codexLoginFixture({
      subject: "user-2",
      refreshToken: "rt-new",
      lastRefresh: "2026-11-04T19:00:00Z",
    });
    const otherAccount = codexLoginFixture({
      accountId: "account-2",
      refreshToken: "rt-new",
      lastRefresh: "2026-11-04T19:00:00Z",
    });
    const sameToken = codexLoginFixture({
      refreshToken: "rt-old",
      lastRefresh: "2026-11-04T19:00:00Z",
    });
    expect(isNewerRenewalOfSameCodexLogin(otherUser, consumed)).toBe(false);
    expect(isNewerRenewalOfSameCodexLogin(otherAccount, consumed)).toBe(false);
    expect(isNewerRenewalOfSameCodexLogin(sameToken, consumed)).toBe(false);
  });

  it("falls back to the shared copy for unparseable, API-key or oversized files", () => {
    expect(isNewerRenewalOfSameCodexLogin('{"token":"x"}', consumed)).toBe(false);
    expect(isNewerRenewalOfSameCodexLogin("not json", consumed)).toBe(false);
    expect(
      isNewerRenewalOfSameCodexLogin(
        JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-x" }),
        consumed,
      ),
    ).toBe(false);
    expect(isNewerRenewalOfSameCodexLogin(`${renewed}${" ".repeat(70_000)}`, consumed)).toBe(false);
  });
});
