import { afterEach, describe, expect, it, vi } from "vitest";

import packageJson from "../package.json" with { type: "json" };
import { resolveApplicationVersion } from "./applicationVersion.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("application build version", () => {
  it("uses the source manifest when no compile-time version was supplied", () => {
    expect(resolveApplicationVersion(undefined)).toBe(packageJson.version);
  });

  it.each(["9.8.7", "9.8.7-nightly.20261019.42"])(
    "retains the exact compiled version %s rather than a source-manifest value",
    (version) => {
      expect(resolveApplicationVersion(version)).toBe(version);
    },
  );

  it("does not turn inherited APP_VERSION into a source runtime identity", async () => {
    vi.stubEnv("APP_VERSION", "99.88.77-untrusted-runtime");
    vi.resetModules();

    const { APPLICATION_VERSION } = await import("./applicationVersion.ts");

    expect(APPLICATION_VERSION).toBe(packageJson.version);
  });

  it("captures the injected build identity once despite later ambient changes", async () => {
    // A test-owned global exercises the free compile-time identifier's source
    // branch. The real emitted-bundle regression separately proves that
    // the production bundler replaces it with a literal, not a runtime global.
    vi.stubGlobal("__CAFE_CODE_BUILD_VERSION__", "9.8.7");
    vi.stubEnv("APP_VERSION", "99.88.77-untrusted-runtime");
    vi.resetModules();
    const { APPLICATION_VERSION } = await import("./applicationVersion.ts");

    vi.stubGlobal("__CAFE_CODE_BUILD_VERSION__", "8.7.6");
    vi.stubEnv("APP_VERSION", "88.77.66-later-runtime");

    expect(APPLICATION_VERSION).toBe("9.8.7");
    expect((await import("./applicationVersion.ts")).APPLICATION_VERSION).toBe("9.8.7");
  });
});
