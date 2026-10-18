import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";

import {
  deriveAuthClientMetadata,
  resolveHttpsSessionCookieName,
  resolveSessionCookieName,
} from "./utils.ts";

describe("profile session cookie names", () => {
  it("keeps Production and unprofiled standalone names compatible", () => {
    for (const dataProfile of [undefined, "production"] as const) {
      expect(resolveSessionCookieName({ mode: "web", port: 3773, dataProfile })).toBe("t3_session");
      expect(resolveSessionCookieName({ mode: "desktop", port: 3773, dataProfile })).toBe(
        "t3_session_3773",
      );
      expect(resolveHttpsSessionCookieName({ port: 3774, dataProfile })).toBe(
        "t3_session_https_3774",
      );
    }
  });

  it("separates explicit Debug cookies by actual listener port independent of mode", () => {
    for (const mode of ["web", "desktop"] as const) {
      expect(resolveSessionCookieName({ mode, port: 13773, dataProfile: "debug" })).toBe(
        "t3_debug_session_13773",
      );
      expect(resolveSessionCookieName({ mode, port: 13775, dataProfile: "debug" })).toBe(
        "t3_debug_session_13775",
      );
    }
    expect(resolveHttpsSessionCookieName({ port: 13774, dataProfile: "debug" })).toBe(
      "t3_debug_session_https_13774",
    );
    expect(resolveHttpsSessionCookieName({ port: 13776, dataProfile: "debug" })).toBe(
      "t3_debug_session_https_13776",
    );
  });
});

describe("deriveAuthClientMetadata", () => {
  it("labels Electron user agents as Electron instead of Chrome", () => {
    const metadata = deriveAuthClientMetadata({
      request: {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) t3code/0.0.15 Chrome/136.0.7103.93 Electron/36.3.2 Safari/537.36",
        },
        remoteAddress: Option.some("::ffff:127.0.0.1"),
        source: {
          remoteAddress: "::ffff:127.0.0.1",
        },
      } as never,
    });

    expect(metadata).toMatchObject({
      browser: "Electron",
      deviceType: "desktop",
      ipAddress: "127.0.0.1",
      os: "macOS",
    });
  });
});
