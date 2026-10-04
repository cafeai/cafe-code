import {
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationSession,
} from "@cafecode/contracts";
import { describe, expect, it } from "vitest";

import { sessionLifecycleSnapshot } from "./sessionLifecycle.ts";

const session: OrchestrationSession = {
  threadId: ThreadId.make("lifecycle-normalization-thread"),
  status: "running",
  providerName: "grok",
  providerInstanceId: ProviderInstanceId.make("grok"),
  runtimeMode: "full-access",
  activeTurnId: TurnId.make("lifecycle-normalization-turn"),
  lastError: null,
  updatedAt: "2026-10-04T08:28:05.900Z",
};

describe("sessionLifecycleSnapshot", () => {
  it.each([{}, { subagentRuntimeId: undefined }, { subagentRuntimeId: null }])(
    "canonicalizes absent native-generation evidence without changing the source: %j",
    (runtimeFields) => {
      const input = { ...session, ...runtimeFields };
      const original = { ...input };
      expect(sessionLifecycleSnapshot(input)).toEqual({
        status: "running",
        activeTurnId: session.activeTurnId,
        providerName: "grok",
        providerInstanceId: session.providerInstanceId,
        subagentRuntimeId: null,
        updatedAt: session.updatedAt,
      });
      expect(input).toStrictEqual(original);
    },
  );

  it("preserves concrete native generations and a missing session as different identities", () => {
    const first = "00000000-0000-4000-8000-000000000001";
    const replacement = "00000000-0000-4000-8000-000000000002";
    const firstSnapshot = sessionLifecycleSnapshot({ ...session, subagentRuntimeId: first });
    const replacementSnapshot = sessionLifecycleSnapshot({
      ...session,
      subagentRuntimeId: replacement,
    });
    expect(firstSnapshot?.subagentRuntimeId).toBe(first);
    expect(replacementSnapshot?.subagentRuntimeId).toBe(replacement);
    expect(firstSnapshot).not.toEqual(replacementSnapshot);
    expect(firstSnapshot).not.toEqual(sessionLifecycleSnapshot(session));
    expect(sessionLifecycleSnapshot(null)).toBeNull();
    expect(sessionLifecycleSnapshot(session)).not.toBeNull();
  });

  it("canonicalizes legacy captured guards with absent account and generation fields", () => {
    const { providerInstanceId: _instanceId, ...withoutInstance } = session;
    const legacyGuard = {
      status: session.status,
      activeTurnId: session.activeTurnId,
      providerName: session.providerName,
      providerInstanceId: null,
      updatedAt: session.updatedAt,
    };
    expect(sessionLifecycleSnapshot(legacyGuard)).toEqual(
      sessionLifecycleSnapshot(withoutInstance),
    );
  });
});
