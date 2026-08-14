import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@cafecode/contracts";
import { describe, expect, it } from "vitest";

import { providerAccountRateLimitUpdateFromEvent } from "./ProviderAccountRateLimitsReactor.ts";

describe("providerAccountRateLimitUpdateFromEvent", () => {
  it("routes a live Codex weekly rate-limit notification into the snapshot merge path", () => {
    const event = {
      eventId: EventId.make("evt-rate-limits"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      threadId: ThreadId.make("thread-rate-limits"),
      createdAt: "2026-08-12T15:00:00.000Z",
      type: "account.rate-limits.updated",
      payload: {
        rateLimits: {
          rateLimits: {
            limitId: "codex",
            planType: "pro",
            primary: { usedPercent: 1, windowDurationMins: 10_080 },
            secondary: null,
          },
        },
      },
    } as ProviderRuntimeEvent;

    expect(providerAccountRateLimitUpdateFromEvent(event)).toEqual({
      kind: "snapshot",
      instanceId: ProviderInstanceId.make("codex"),
      limitId: "codex",
      snapshot: {
        limitId: "codex",
        planType: "pro",
        primary: { usedPercent: 1, windowDurationMins: 10_080 },
      },
    });
  });
});
