import { afterEach, describe, expect, it, vi } from "vitest";
import * as i18n from "@cafecode/shared/i18n";

import {
  isLoopbackHostname,
  isLoopbackRemoteAddress,
  renderHttpsBootstrapPage,
  resolveHttpsBootstrapLocale,
  resolveDevRedirectUrl,
} from "./http.ts";

afterEach(() => vi.restoreAllMocks());

describe("localized HTTPS bootstrap document", () => {
  it.each(["en", "ja", "ko"] as const)(
    "uses isolated %s metadata and copy without mutating active locale",
    (locale) => {
      const original = i18n.getUiLocale();
      const html = renderHttpsBootstrapPage({
        hostname: "cafe.example",
        httpsPort: 9443,
        uiLocale: locale,
      });
      expect(html).toContain(`<html lang="${locale}" dir="ltr">`);
      expect(html).toContain(i18n.getUiTranslator(locale).text("This server uses HTTPS"));
      expect(i18n.getUiLocale()).toBe(original);
      expect(html).toContain('href="https://cafe.example:9443/"');
    },
  );
  it("bounds language hints and selects the primary language only", () => {
    expect(resolveHttpsBootstrapLocale("en", "ja-JP,ko;q=0.9")).toBe("en");
    expect(resolveHttpsBootstrapLocale(null, "ja-JP,ko;q=0.9")).toBe("ja");
    expect(resolveHttpsBootstrapLocale(null, "ko-KR;q=0.9,en;q=0.8")).toBe("ko");
    expect(resolveHttpsBootstrapLocale(null, "fr-FR,ja-JP;q=0.8")).toBe("en");
    expect(resolveHttpsBootstrapLocale("<script>", "not_a_locale")).toBe("en");
    expect(resolveHttpsBootstrapLocale(null, "ja," + "a".repeat(2048))).toBe("en");
  });
  it("preserves security instructions, trusted inline slots and exact certificate links", () => {
    const html = renderHttpsBootstrapPage({ hostname: "cafe.example", httpsPort: 9443 });
    expect(html).toContain('<html lang="en" dir="ltr">');
    expect(html).toContain("Cafe Code — secure connection required");
    expect(html).toContain("install Cafe Code&#39;s certificate on this device");
    expect(html).toContain("<strong>iOS:</strong>");
    expect(html).toContain("VPN &amp; Device Management");
    expect(html).toContain("<strong>Android:</strong>");
    expect(html).toContain("Then open <code>https://cafe.example:9443/</code>");
    expect(html).toContain('href="https://cafe.example:9443/"');
    expect(html).toContain('download="cafe-code.crt"');
    expect(html).not.toContain("<script");
  });

  it("escapes translated text and hostile interpolation without creating arbitrary HTML", () => {
    vi.spyOn(i18n, "uiText").mockReturnValue('<img src="bad" onerror="attack">&');
    const html = renderHttpsBootstrapPage({
      hostname: '\"</code><script>attack</script>&',
      httpsPort: 9443,
    });
    expect(html).toContain("&lt;img src=&quot;bad&quot; onerror=&quot;attack&quot;&gt;&amp;");
    expect(html).toContain("&lt;/code&gt;&lt;script&gt;attack&lt;/script&gt;&amp;");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html.match(/<code>/g)).toHaveLength(1);
  });
});

describe("http dev routing", () => {
  const hostnameScenarios = [
    ["127.0.0.1", true],
    ["localhost", true],
    ["::1", true],
    ["[::1]", true],
    ["192.168.86.35", false],
    ["10.0.0.24", false],
    ["example.local", false],
  ] as const;

  for (const [hostname, expected] of hostnameScenarios) {
    it(`${expected ? "accepts" : "rejects"} ${hostname} as loopback`, () => {
      expect(isLoopbackHostname(hostname)).toBe(expected);
    });
  }

  const remoteAddressScenarios = [
    ["127.0.0.1", true],
    ["127.42.1.9", true],
    ["::1", true],
    ["[::1]", true],
    ["::ffff:127.0.0.1", true],
    ["::ffff:127.42.1.9", true],
    ["192.168.86.35", false],
    ["::ffff:192.168.86.35", false],
  ] as const;

  for (const [address, expected] of remoteAddressScenarios) {
    it(`${expected ? "accepts" : "rejects"} ${address} as a same-machine peer`, () => {
      expect(isLoopbackRemoteAddress(address)).toBe(expected);
    });
  }

  it("preserves path and query when redirecting to the dev server", () => {
    const devUrl = new URL("http://127.0.0.1:5173/");
    const requestUrl = new URL("http://127.0.0.1:3774/pair?token=test-token");

    expect(resolveDevRedirectUrl(devUrl, requestUrl)).toBe(
      "http://127.0.0.1:5173/pair?token=test-token",
    );
  });
});
