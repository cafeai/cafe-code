import { ProviderInstanceId } from "@cafecode/contracts";
import { describe, expect, it } from "vitest";

import { makeGrokContinuationGroupKey } from "./GrokDriver.ts";

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
