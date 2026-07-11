import { describe, expect, it } from "vitest";

import { isLoopbackHostname, resolveDevRedirectUrl } from "./http.ts";

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

  it("preserves path and query when redirecting to the dev server", () => {
    const devUrl = new URL("http://127.0.0.1:5173/");
    const requestUrl = new URL("http://127.0.0.1:3774/pair?token=test-token");

    expect(resolveDevRedirectUrl(devUrl, requestUrl)).toBe(
      "http://127.0.0.1:5173/pair?token=test-token",
    );
  });
});
