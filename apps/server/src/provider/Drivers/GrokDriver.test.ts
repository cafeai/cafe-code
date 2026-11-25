import { ProviderInstanceId } from "@cafecode/contracts";
import { describe, expect, it } from "vitest";

import {
  isGrokNativeUpdatePath,
  makeGrokContinuationGroupKey,
  parseGrokLatestVersionFromUpdateCheck,
  resolveGrokMaintenanceCapabilities,
} from "./GrokDriver.ts";

describe("makeGrokContinuationGroupKey", () => {
  it("shares the actual default home identity but isolates distinct Grok homes", () => {
    const instanceId = ProviderInstanceId.make("grok-work");
    expect(makeGrokContinuationGroupKey(instanceId, "")).toBe(
      makeGrokContinuationGroupKey(instanceId, "~/.grok"),
    );
    expect(makeGrokContinuationGroupKey(instanceId, "/tmp/grok-a")).not.toBe(
      makeGrokContinuationGroupKey(instanceId, "/tmp/grok-b"),
    );
  });

  it("does not expose the resolved home path in the continuation key", () => {
    const key = makeGrokContinuationGroupKey(
      ProviderInstanceId.make("grok-private"),
      "/private/users/alice/.grok",
    );
    expect(key).not.toContain("/private/users/alice");
  });
});

describe("Grok native update capabilities", () => {
  it("enables native grok update only for default or native install paths", () => {
    expect(isGrokNativeUpdatePath("")).toBe(true);
    expect(isGrokNativeUpdatePath("grok")).toBe(true);
    expect(isGrokNativeUpdatePath("/Users/alice/.local/bin/grok")).toBe(true);
    expect(isGrokNativeUpdatePath("/Users/alice/.grok/bin/grok")).toBe(true);
    expect(isGrokNativeUpdatePath("/opt/custom/bin/grok")).toBe(false);

    const nativeCaps = resolveGrokMaintenanceCapabilities("");
    expect(nativeCaps.update).toEqual({
      command: "grok update",
      executable: "grok",
      args: ["update"],
      lockKey: "grok-native",
    });

    const manualCaps = resolveGrokMaintenanceCapabilities("/opt/custom/bin/grok");
    expect(manualCaps.update).toBeNull();
  });

  it("parses valid semver latestVersion from grok update --check --json", () => {
    expect(
      parseGrokLatestVersionFromUpdateCheck(
        JSON.stringify({
          currentVersion: "1.0.91",
          latestVersion: "1.0.92",
          updateAvailable: true,
        }),
      ),
    ).toBe("1.0.92");
    expect(parseGrokLatestVersionFromUpdateCheck("not json")).toBeNull();
    expect(
      parseGrokLatestVersionFromUpdateCheck(JSON.stringify({ latestVersion: null })),
    ).toBeNull();
  });
});
