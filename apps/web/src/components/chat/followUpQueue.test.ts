import { describe, expect, it } from "vitest";

import {
  canStartQueuedFollowUpTurn,
  canExpandQueuedFollowUpText,
  decideQueuedFollowUpAction,
  decideFollowUpDelivery,
  previewQueuedFollowUpText,
  queuedFollowUpActionLabel,
  queuedFollowUpActionTitle,
  rekeyQueuedFollowUpsForActiveThread,
} from "./followUpQueue";

describe("followUpQueue", () => {
  type TestQueuedFollowUp = {
    id: string;
    threadId: string;
    blockedReason: string | null;
    promptText?: string;
  };

  it("sends normally when idle even if steer was requested", () => {
    expect(
      decideFollowUpDelivery({
        phase: "ready",
        requestedSteer: true,
        liveSteerSupported: true,
      }),
    ).toBe("send");
  });

  it("queues normal submit while a turn is running", () => {
    expect(
      decideFollowUpDelivery({
        phase: "running",
        requestedSteer: false,
        liveSteerSupported: true,
      }),
    ).toBe("queue");
  });

  it("steers a running turn only when provider support is explicit", () => {
    expect(
      decideFollowUpDelivery({
        phase: "running",
        requestedSteer: true,
        liveSteerSupported: true,
      }),
    ).toBe("steer");
    expect(
      decideFollowUpDelivery({
        phase: "running",
        requestedSteer: true,
        liveSteerSupported: false,
      }),
    ).toBe("queue-unsupported");
  });

  it("normalizes queue preview text", () => {
    expect(previewQueuedFollowUpText("  fix\n\nthis   next  ")).toBe("fix this next");
    expect(previewQueuedFollowUpText("   ")).toBe("Image-only follow-up");
  });

  it("only expands queued prompts that need a detail view", () => {
    expect(canExpandQueuedFollowUpText("say yes")).toBe(false);
    expect(canExpandQueuedFollowUpText("first line\nsecond line")).toBe(true);
    expect(
      canExpandQueuedFollowUpText(
        "This queued follow-up is intentionally long enough that the collapsed row is likely to truncate it before the user can read the full text.",
      ),
    ).toBe(true);
  });

  it("chooses a concrete queued-item action instead of silently no-oping", () => {
    expect(
      decideQueuedFollowUpAction({
        phase: "running",
        liveSteerSupported: true,
        canDispatchNow: true,
      }),
    ).toBe("steer");
    expect(
      decideQueuedFollowUpAction({
        phase: "ready",
        liveSteerSupported: true,
        canDispatchNow: true,
      }),
    ).toBe("send");
    expect(
      decideQueuedFollowUpAction({
        phase: "running",
        liveSteerSupported: false,
        canDispatchNow: true,
      }),
    ).toBe("interrupt");
    expect(
      decideQueuedFollowUpAction({
        phase: "running",
        liveSteerSupported: false,
        canDispatchNow: false,
      }),
    ).toBe("wait");
    expect(
      decideQueuedFollowUpAction({
        phase: "ready",
        liveSteerSupported: true,
        canDispatchNow: false,
      }),
    ).toBe("wait");
  });

  it("labels queued item actions by provider capability and phase", () => {
    expect(queuedFollowUpActionLabel({ phase: "running", liveSteerSupported: true })).toBe("Steer");
    expect(queuedFollowUpActionLabel({ phase: "running", liveSteerSupported: false })).toBe(
      "Interrupt",
    );
    expect(queuedFollowUpActionLabel({ phase: "ready", liveSteerSupported: false })).toBe("Send");
    expect(queuedFollowUpActionTitle({ phase: "running", liveSteerSupported: false })).toContain(
      "Interrupt the active turn",
    );
  });

  it("starts queued follow-ups from the visible idle state without consulting stale send flags", () => {
    expect(
      canStartQueuedFollowUpTurn({
        queueLength: 1,
        firstItemBlocked: false,
        isWorking: false,
        isConnecting: false,
        isEnvironmentUnavailable: false,
        isDispatchInFlight: false,
      }),
    ).toBe(true);
    expect(
      canStartQueuedFollowUpTurn({
        queueLength: 1,
        firstItemBlocked: false,
        isWorking: true,
        isConnecting: false,
        isEnvironmentUnavailable: false,
        isDispatchInFlight: false,
      }),
    ).toBe(false);
    expect(
      canStartQueuedFollowUpTurn({
        queueLength: 1,
        firstItemBlocked: false,
        isWorking: false,
        isConnecting: false,
        isEnvironmentUnavailable: false,
        isDispatchInFlight: true,
      }),
    ).toBe(false);
  });

  it("rekeys an orphaned draft queue onto the active server thread", () => {
    const queues: Record<string, TestQueuedFollowUp[]> = {
      "draft-thread": [
        {
          id: "queued-1",
          threadId: "draft-thread",
          blockedReason: "stale error",
          promptText: "next",
        },
      ],
    };

    const next = rekeyQueuedFollowUpsForActiveThread<string, TestQueuedFollowUp>({
      queuesByThreadId: queues,
      activeThreadId: "server-thread",
      previousActiveThreadId: "draft-thread",
      knownThreadIds: new Set(["server-thread"]),
    });

    expect(next["draft-thread"]).toBeUndefined();
    expect(next["server-thread"]).toEqual([
      {
        id: "queued-1",
        threadId: "server-thread",
        blockedReason: null,
        promptText: "next",
      },
    ]);
  });

  it("does not steal a queue from another known server thread", () => {
    const queues: Record<string, TestQueuedFollowUp[]> = {
      other: [
        {
          id: "queued-1",
          threadId: "other",
          blockedReason: null,
        },
      ],
    };

    const next = rekeyQueuedFollowUpsForActiveThread<string, TestQueuedFollowUp>({
      queuesByThreadId: queues,
      activeThreadId: "active",
      previousActiveThreadId: null,
      knownThreadIds: new Set(["active", "other"]),
    });

    expect(next).toBe(queues);
  });
});
