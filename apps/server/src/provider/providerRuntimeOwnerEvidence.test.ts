import { describe, expect, it } from "vitest";

import {
  hasLiveProviderRuntimeOwner,
  PROVIDER_RUNTIME_OWNER_MAX_HEARTBEAT_AGE_MS,
} from "./providerRuntimeOwnerEvidence.ts";

const ownerId = "00000000-0000-4000-8000-000000000001";

function ownerPayload(input?: {
  readonly pid?: number;
  readonly startedAtMs?: number;
  readonly heartbeatAtMs?: number;
}) {
  const now = Date.now();
  return {
    runtimeOwnerId: ownerId,
    runtimeOwnerPid: input?.pid ?? process.pid,
    runtimeOwnerStartedAt: new Date(input?.startedAtMs ?? now).toISOString(),
    runtimeOwnerHeartbeatAt: new Date(input?.heartbeatAtMs ?? now).toISOString(),
  };
}

describe("provider runtime owner evidence", () => {
  it("accepts a fresh heartbeat from the current live process", () => {
    const now = Date.now();
    expect(hasLiveProviderRuntimeOwner(ownerPayload({ heartbeatAtMs: now }), now)).toBe(true);
  });

  it("rejects stale owner evidence even when the recorded PID still exists", () => {
    const now = Date.now();
    expect(
      hasLiveProviderRuntimeOwner(
        ownerPayload({
          startedAtMs: now - PROVIDER_RUNTIME_OWNER_MAX_HEARTBEAT_AGE_MS - 2_000,
          heartbeatAtMs: now - PROVIDER_RUNTIME_OWNER_MAX_HEARTBEAT_AGE_MS - 1_000,
        }),
        now,
      ),
    ).toBe(false);
  });

  it("rejects a fresh-looking lease whose owner process does not exist", () => {
    const now = Date.now();
    expect(hasLiveProviderRuntimeOwner(ownerPayload({ pid: 2_147_483_647 }), now)).toBe(false);
  });

  it("rejects malformed owner metadata before probing a PID", () => {
    const now = Date.now();
    expect(
      hasLiveProviderRuntimeOwner(
        {
          ...ownerPayload(),
          runtimeOwnerId: "not-an-owner-id",
        },
        now,
      ),
    ).toBe(false);
  });
});
