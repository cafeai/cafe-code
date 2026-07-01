import { describe, expect, it } from "vitest";

import { compareVersions, isReleaseNewer, parseVersion } from "./DesktopReleaseUpdates.ts";

describe("parseVersion", () => {
  it("parses plain and v-prefixed versions", () => {
    expect(parseVersion("1.2.3")).toEqual({ release: [1, 2, 3], prerelease: null });
    expect(parseVersion("v0.0.51")).toEqual({ release: [0, 0, 51], prerelease: null });
  });

  it("captures prerelease and drops build metadata", () => {
    expect(parseVersion("1.2.3-nightly.4+abc")).toEqual({
      release: [1, 2, 3],
      prerelease: "nightly.4",
    });
  });

  it("returns null for unparseable input", () => {
    expect(parseVersion("")).toBeNull();
    expect(parseVersion("not-a-version")).toBeNull();
  });
});

describe("compareVersions", () => {
  it("orders by numeric core", () => {
    expect(compareVersions("0.0.52", "0.0.51")).toBe(1);
    expect(compareVersions("0.1.0", "0.0.99")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0", "1.0.1")).toBe(-1);
  });

  it("ranks a stable release above a prerelease of the same core", () => {
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
  });

  it("returns null when either side is unparseable", () => {
    expect(compareVersions("nope", "1.0.0")).toBeNull();
  });
});

describe("isReleaseNewer", () => {
  it("is true only when latest exceeds current", () => {
    expect(isReleaseNewer("0.0.52", "0.0.51")).toBe(true);
    expect(isReleaseNewer("v0.0.52", "0.0.51")).toBe(true);
    expect(isReleaseNewer("0.0.51", "0.0.51")).toBe(false);
    expect(isReleaseNewer("0.0.50", "0.0.51")).toBe(false);
  });

  it("never claims an update for unparseable versions", () => {
    expect(isReleaseNewer("garbage", "0.0.51")).toBe(false);
  });
});
