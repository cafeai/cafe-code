import { describe, expect, it } from "vitest";

import { resolveWebUiConnectionSetupUrl } from "./webUiConnectionSetup";

describe("resolveWebUiConnectionSetupUrl", () => {
  it("derives the HTTP setup URL from a secure Web UI URL", () => {
    expect(
      resolveWebUiConnectionSetupUrl({
        hostname: "192.168.1.107",
        port: "3775",
        protocol: "https:",
      }),
    ).toBe("http://192.168.1.107:3773/");
  });

  it("does not offer setup from an HTTP URL", () => {
    expect(
      resolveWebUiConnectionSetupUrl({
        hostname: "192.168.1.107",
        port: "3773",
        protocol: "http:",
      }),
    ).toBe(null);
  });
});
