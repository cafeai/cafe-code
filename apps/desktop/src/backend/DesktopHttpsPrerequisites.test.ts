import { assert, describe, it } from "@effect/vitest";

import { isDesktopHttpsSupported } from "./DesktopHttpsPrerequisites.ts";

describe("DesktopHttpsPrerequisites", () => {
  it("preserves HTTPS support outside Windows", () => {
    assert.equal(
      isDesktopHttpsSupported({
        platform: "linux",
        commandIsUsable: () => false,
      }),
      true,
    );
  });

  it("enables HTTPS on Windows when either OpenSSL command can run", () => {
    assert.equal(
      isDesktopHttpsSupported({
        platform: "win32",
        commandIsUsable: (command) => command === "openssl",
      }),
      true,
    );
  });

  it("disables HTTPS on Windows when OpenSSL is unavailable", () => {
    assert.equal(
      isDesktopHttpsSupported({
        platform: "win32",
        commandIsUsable: () => false,
      }),
      false,
    );
  });
});
