import * as ProviderDateTime from "effect/DateTime";
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
  const now = ProviderDateTime.toEpochMillis(ProviderDateTime.nowUnsafe());
  return {
    runtimeOwnerId: ownerId,
    runtimeOwnerPid: input?.pid ?? process.pid,
    runtimeOwnerStartedAt: ProviderDateTime.formatIso(
      ProviderDateTime.makeUnsafe(input?.startedAtMs ?? now),
    ),
    runtimeOwnerHeartbeatAt: ProviderDateTime.formatIso(
      ProviderDateTime.makeUnsafe(input?.heartbeatAtMs ?? now),
    ),
  };
}

describe("provider runtime owner evidence", () => {
  it("accepts a fresh heartbeat from the current live process", () => {
    const now = ProviderDateTime.toEpochMillis(ProviderDateTime.nowUnsafe());
    expect(hasLiveProviderRuntimeOwner(ownerPayload({ heartbeatAtMs: now }), now)).toBe(true);
  });

  it("rejects stale owner evidence even when the recorded PID still exists", () => {
    const now = ProviderDateTime.toEpochMillis(ProviderDateTime.nowUnsafe());
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
    const now = ProviderDateTime.toEpochMillis(ProviderDateTime.nowUnsafe());
    expect(hasLiveProviderRuntimeOwner(ownerPayload({ pid: 2_147_483_647 }), now)).toBe(false);
  });

  it("rejects malformed owner metadata before probing a PID", () => {
    const now = ProviderDateTime.toEpochMillis(ProviderDateTime.nowUnsafe());
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
