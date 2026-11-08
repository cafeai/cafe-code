import { EventId, TurnId, type OrchestrationThreadActivity } from "@cafecode/contracts";
import { describe, expect, it } from "vitest";

import {
  derivePendingRequestRetention,
  MAX_PENDING_REQUEST_RETENTION_IDENTITIES,
} from "./pendingRequestRetention.ts";

function activity(
  id: string,
  kind: string,
  requestId: string,
  sequence?: number,
  extra: Record<string, unknown> = {},
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    turnId: TurnId.make("historical-request-owner"),
    kind,
    tone: "info",
    summary: "Request lifecycle",
    createdAt: "2026-11-02T00:00:00.000Z",
    ...(sequence === undefined ? {} : { sequence }),
    payload: { requestId, ...extra },
  };
}

describe("pending request presentation retention", () => {
  it("keeps independent approval/question lifecycles and retires only an exact terminal witness", () => {
    const approval = activity("approval-open", "approval.requested", "shared-id", 1);
    const question = activity("question-open", "user-input.requested", "shared-id", 2);
    const ordinaryFailure = activity(
      "approval-retry-failed",
      "provider.approval.respond.failed",
      "shared-id",
      3,
      { detail: "Temporary submission failure" },
    );
    const questionResolved = activity("question-closed", "user-input.resolved", "shared-id", 4);
    const foreignResolved = activity("other-closed", "approval.resolved", "another-id", 5);
    const wrongChannelFailure = activity(
      "approval-unrelated-stale",
      "provider.approval.respond.failed",
      "shared-id",
      6,
      { detail: "Unknown pending user-input request" },
    );
    const open = derivePendingRequestRetention([
      wrongChannelFailure,
      foreignResolved,
      questionResolved,
      ordinaryFailure,
      question,
      approval,
    ]);
    expect(open.pendingCount).toBe(1);
    expect([...open.activityIds]).toEqual([approval.id]);
    expect(open.truncated).toBe(false);

    const stale = activity("approval-stale", "provider.approval.respond.failed", "shared-id", 7, {
      detail: "Unknown pending approval request",
    });
    expect(derivePendingRequestRetention([approval, ordinaryFailure, stale]).pendingCount).toBe(0);
  });

  it("retains a legacy same-clock resolution outside the ordinary tail without reviving the card", () => {
    const requested = activity("z-requested", "user-input.requested", "legacy-id");
    const resolved = activity("a-resolved", "user-input.resolved", "legacy-id");
    const retained = derivePendingRequestRetention([requested, resolved], new Set([requested.id]));
    expect(retained.pendingCount).toBe(0);
    expect([...retained.activityIds]).toEqual([resolved.id]);
    expect(retained.truncated).toBe(false);

    // Explicit canonical sequence still wins over the lifecycle tie rule.
    // An observed later reopening needs its own original request and context.
    const reopened = { ...requested, sequence: 2 };
    const beforeReopen = { ...resolved, sequence: 1 };
    const reopening = derivePendingRequestRetention([reopened, beforeReopen]);
    expect(reopening.pendingCount).toBe(1);
    expect([...reopening.activityIds]).toEqual([requested.id, resolved.id]);
  });

  it("bounds pending presentation identities and reports omitted requests explicitly", () => {
    const requests = Array.from(
      { length: MAX_PENDING_REQUEST_RETENTION_IDENTITIES + 1 },
      (_, index) => activity(`request-${index}`, "approval.requested", `request-${index}`, index),
    );
    const retained = derivePendingRequestRetention(requests);
    expect(retained.pendingCount).toBe(65);
    expect(retained.truncated).toBe(true);
    expect(retained.activityIds.size).toBe(64);
    expect(retained.activityIds.has(requests[0]!.id)).toBe(false);
    expect(retained.activityIds.has(requests[64]!.id)).toBe(true);

    // Recent request payloads already carried by the ordinary tail need no
    // extra retention slot and must not produce a false omission notice.
    const recent = derivePendingRequestRetention(
      requests,
      new Set(requests.map((requested) => requested.id)),
    );
    expect(recent.pendingCount).toBe(65);
    expect(recent.truncated).toBe(false);
    expect(recent.activityIds.size).toBe(64);

    const resolved = activity("last-resolved", "approval.resolved", "request-64", 65);
    const complete = derivePendingRequestRetention([...requests, resolved]);
    expect(complete.pendingCount).toBe(64);
    expect(complete.truncated).toBe(false);
    expect(complete.activityIds.has(requests[0]!.id)).toBe(true);
    expect(complete.activityIds.has(requests[64]!.id)).toBe(false);
    expect(complete.activityIds.size).toBe(64);
  });
});
