import { describe, expect, it } from "vitest";

import {
  canTypeSensitiveValue,
  embeddedBrowserDisplayUrl,
  normalizeEmbeddedBrowserUrl,
  redactEmbeddedBrowserText,
} from "./embeddedBrowserSecurity.ts";

describe("embedded browser address policy", () => {
  it.each([
    [" example.test/path ", "https://example.test/path"],
    [
      "HTTPS://EXAMPLE.TEST:443/path?q=visible#section",
      "https://example.test/path?q=visible#section",
    ],
    ["http://localhost:3000", "http://localhost:3000/"],
    ["about:blank", "about:blank"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeEmbeddedBrowserUrl(input)).toBe(expected);
  });

  it.each([
    "",
    " ",
    "https://",
    "https://example.test:99999",
    "https://user:synthetic@example.test/",
    "https://user@example.test/",
    "https://example.test@other.test/",
    "javascript:alert(1)",
    "data:text/html,synthetic",
    "file:///tmp/example.html",
    "ftp://example.test/",
    "about:config",
  ])("rejects invalid, credential-bearing, or unsupported addresses: %s", (input) => {
    expect(normalizeEmbeddedBrowserUrl(input)).toBeNull();
  });

  it("removes credentials, query, and fragment from a display URL", () => {
    expect(
      embeddedBrowserDisplayUrl("https://reader:synthetic@example.test/path?key=example#fragment"),
    ).toBe("https://example.test/path");
  });

  it.each(["", "not a URL", "about:blank", "javascript:synthetic", "data:text/plain,synthetic"])(
    "uses a blank display for unsupported input: %s",
    (input) => {
      expect(embeddedBrowserDisplayUrl(input)).toBe("about:blank");
    },
  );

  it("keeps encoded path components intact; display is not whole-URL secret redaction", () => {
    expect(embeddedBrowserDisplayUrl("https://example.test/a%2Fb?q=example#part")).toBe(
      "https://example.test/a%2Fb",
    );
  });
});

describe("sensitive entry transport eligibility", () => {
  it.each([
    "https://example.test/login",
    "http://localhost:3000/login",
    "http://LOCALHOST/login",
    "http://127.0.0.1/login",
    "http://127.255.255.254/login",
    "http://[::1]:3000/login",
    "http://127.1/login",
  ])("permits HTTPS or canonical loopback HTTP: %s", (input) => {
    expect(canTypeSensitiveValue(input)).toBe(true);
  });

  it.each([
    "http://example.test/login",
    "http://localhost.example.test/login",
    "http://127.0.0.1.example.test/login",
    "http://127.0.0.256/login",
    "http://192.168.1.1/login",
    "http://[::2]/login",
    "http://[::ffff:127.0.0.1]/login",
    "https://reader:synthetic@example.test/login",
    "http://reader@localhost/login",
    "file:///tmp/example.html",
    "about:blank",
    "not a URL",
  ])("refuses unsupported transport and loopback lookalikes: %s", (input) => {
    expect(canTypeSensitiveValue(input)).toBe(false);
  });
});

describe("bounded heuristic page-text redaction", () => {
  it("preserves ordinary English and Japanese text", () => {
    const text = "Welcome to the project. プロジェクトへようこそ。";
    expect(redactEmbeddedBrowserText(text, 100)).toBe(text);
  });

  it("redacts synthetic token shapes, labelled secrets, and numeric codes", () => {
    const token = `${"a".repeat(24)}.${"b".repeat(12)}.${"c".repeat(12)}`;
    const text = `Bearer ${token}\napi-${"d".repeat(16)}\npassword=synthetic\n123456`;
    expect(redactEmbeddedBrowserText(text, 300)).toBe(
      "[redacted token]\n[redacted token]\npassword=[redacted secret]\n[redacted numeric code]",
    );
  });

  it.each(["passwd", "pwd", "client-secret", "recovery-code"])(
    "redacts the synthetic value of %s",
    (label) => {
      expect(redactEmbeddedBrowserText(`${label}: synthetic-example`, 100)).toBe(
        `${label}: [redacted secret]`,
      );
    },
  );

  it("redacts before clipping, including a token that crosses the output limit", () => {
    expect(redactEmbeddedBrowserText(`api-${"x".repeat(20)}`, 8)).toBe("[redacte");
  });

  it("redacts the whole labelled secret even when its value is short or exceeds 128 characters", () => {
    for (const value of ["x", "x".repeat(129), "x".repeat(2_000)]) {
      expect(redactEmbeddedBrowserText(`password=${value}\nNext line`, 3_000)).toBe(
        "password=[redacted secret]\nNext line",
      );
    }
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "returns no text for an invalid or empty output limit: %s",
    (limit) => {
      expect(redactEmbeddedBrowserText("ordinary content", limit)).toBe("");
    },
  );
});
