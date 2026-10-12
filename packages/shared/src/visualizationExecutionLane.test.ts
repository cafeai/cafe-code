import { describe, expect, it, vi } from "vitest";
import {
  createVisualizationExecutionLane,
  VISUALIZATION_EXECUTION_MAX_BUDGET_MS,
  VISUALIZATION_EXECUTION_MAX_WAITING,
  type VisualizationExecutionAdmission,
  type VisualizationExecutionKind,
  type VisualizationExecutionLease,
  type VisualizationExecutionOwner,
  type VisualizationExecutionRequest,
  type VisualizationRetirementObservation,
} from "./visualizationExecutionLane.ts";

function fixture() {
  let nowMs = 0;
  const readMonotonicMs = vi.fn(() => nowMs);
  return {
    ...createVisualizationExecutionLane({ readMonotonicMs }),
    readMonotonicMs,
    setNow: (value: number) => {
      nowMs = value;
    },
  };
}

function enqueue(
  context: ReturnType<typeof fixture>,
  kind: VisualizationExecutionKind = "preview",
  budgetMs = 1_000,
) {
  const result = context.lane.enqueue(kind, budgetMs);
  expect(result.status).toBe("queued");
  if (result.status !== "queued") throw new Error("Expected queued request.");
  return result;
}

function admit(context: ReturnType<typeof fixture>): VisualizationExecutionAdmission {
  const result = context.lane.admitNext();
  expect(result.status).toBe("admitted");
  if (result.status !== "admitted") throw new Error("Expected admitted request.");
  return result.admission;
}

function observe(context: ReturnType<typeof fixture>, admission: VisualizationExecutionAdmission) {
  const observation = context.retirementOwner.beginObservation(admission.owner, admission.lease);
  expect(observation).not.toBeNull();
  if (observation === null) throw new Error("Expected retirement observation.");
  return observation;
}

describe("bounded visualization execution lane", () => {
  it("admits only one preview or viewer across the shared owning lane", () => {
    const context = fixture();
    const first = enqueue(context);
    const active = admit(context);
    expect(active.request).toBe(first.request);
    enqueue(context, "viewer");
    enqueue(context, "preview");
    expect(context.lane.admitNext()).toEqual({ status: "unavailable", reason: "occupied" });
    expect(context.lane.enqueue("viewer", 1_000)).toEqual({
      status: "refused",
      reason: "saturated",
    });
    expect(context.lane.snapshot()).toMatchObject({
      state: "running",
      waitingCount: VISUALIZATION_EXECUTION_MAX_WAITING,
      activeKind: "preview",
      responseAvailable: true,
    });
  });

  it("bounds the waiting queue even before explicit admission", () => {
    const context = fixture();
    enqueue(context);
    enqueue(context);
    for (let index = 0; index < 100; index++) {
      expect(context.lane.enqueue("preview", 1_000)).toEqual({
        status: "refused",
        reason: "saturated",
      });
    }
    expect(context.lane.snapshot().waitingCount).toBe(2);
    expect(context.lane.snapshot().state).toBe("idle");
  });

  it("uses a fixed enqueue deadline, including waiting and admission time", () => {
    const context = fixture();
    context.setNow(100);
    const queued = enqueue(context, "viewer", 500);
    context.setNow(400);
    const active = admit(context);
    expect(queued.deadlineAtMs).toBe(600);
    expect(active.deadlineAtMs).toBe(600);
    context.setNow(599.5);
    expect(context.lane.canRespond(active.lease)).toBe(true);
    context.setNow(600);
    expect(context.lane.complete(active.lease)).toBe("unavailable");
    expect(context.lane.snapshot()).toMatchObject({ state: "retiring", revocation: "deadline" });
  });

  it("removes expired waiting requests without starting them or retaining history", () => {
    const context = fixture();
    const expired = enqueue(context, "preview", 100);
    const retained = enqueue(context, "viewer", 500);
    context.setNow(100);
    expect(context.lane.sweep().waitingCount).toBe(1);
    expect(context.lane.cancel(expired.request)).toBe("unavailable");
    expect(admit(context).request).toBe(retained.request);
  });

  it("allows cancellation of exact waiting work without disturbing another request", () => {
    const context = fixture();
    const cancelled = enqueue(context);
    const retained = enqueue(context, "viewer");
    expect(context.lane.cancel(cancelled.request)).toBe("queued-cancelled");
    expect(context.lane.cancel(cancelled.request)).toBe("unavailable");
    expect(admit(context).request).toBe(retained.request);
  });

  it("revokes cancellation immediately but retains admission until exact retirement", () => {
    const context = fixture();
    const request = enqueue(context);
    const active = admit(context);
    const pending = enqueue(context, "viewer");
    expect(context.lane.cancel(request.request)).toBe("retirement-required");
    expect(context.lane.canRespond(active.lease)).toBe(false);
    expect(context.lane.complete(active.lease)).toBe("unavailable");
    expect(context.lane.admitNext()).toEqual({ status: "unavailable", reason: "occupied" });
    const observation = observe(context, active);
    expect(context.retirementOwner.settleObservation(observation, "retired")).toBe("retired");
    expect(context.lane.snapshot().state).toBe("idle");
    expect(admit(context).request).toBe(pending.request);
  });

  it("accepts completion only once and does not equate result completion with retirement", () => {
    const context = fixture();
    enqueue(context);
    const active = admit(context);
    enqueue(context, "viewer");
    expect(context.lane.complete(active.lease)).toBe("accepted");
    expect(context.lane.complete(active.lease)).toBe("unavailable");
    expect(context.lane.canRespond(active.lease)).toBe(false);
    expect(context.lane.snapshot()).toMatchObject({ state: "retiring", revocation: "completed" });
    expect(context.lane.admitNext()).toEqual({ status: "unavailable", reason: "occupied" });
  });

  it("quarantines a lost acknowledgement and accepts only a fresh exact observation", () => {
    const context = fixture();
    enqueue(context);
    const active = admit(context);
    const lost = observe(context, active);
    expect(context.retirementOwner.quarantine(active.owner, active.lease)).toBe(true);
    expect(context.retirementOwner.settleObservation(lost, "retired")).toBe("unavailable");
    expect(context.lane.snapshot()).toMatchObject({
      state: "quarantined",
      responseAvailable: false,
    });
    expect(context.lane.admitNext()).toEqual({ status: "unavailable", reason: "occupied" });

    const stillRunning = observe(context, active);
    expect(context.retirementOwner.settleObservation(stillRunning, "running")).toBe("retained");
    expect(context.lane.snapshot().state).toBe("quarantined");
    const retired = observe(context, active);
    expect(context.retirementOwner.settleObservation(retired, "retired")).toBe("retired");
    expect(context.lane.snapshot().state).toBe("idle");
  });

  it("keeps uncertain retirement quarantined regardless of cancellation or time", () => {
    const context = fixture();
    const request = enqueue(context);
    const active = admit(context);
    const observation = observe(context, active);
    expect(context.retirementOwner.settleObservation(observation, "uncertain")).toBe("retained");
    context.setNow(30_000);
    expect(context.lane.cancel(request.request)).toBe("retirement-required");
    expect(context.lane.snapshot().state).toBe("quarantined");
    expect(context.lane.admitNext()).toEqual({ status: "unavailable", reason: "occupied" });
  });

  it("retains only one outstanding retirement observation", () => {
    const context = fixture();
    enqueue(context);
    const active = admit(context);
    const observation = observe(context, active);
    expect(context.retirementOwner.beginObservation(active.owner, active.lease)).toBeNull();
    expect(context.retirementOwner.settleObservation(observation, "running")).toBe("retained");
    expect(context.retirementOwner.settleObservation(observation, "retired")).toBe("unavailable");
    expect(observe(context, active)).not.toBe(observation);
  });

  it.each([null, undefined, true, { retired: true }, "complete"])(
    "quarantines a malformed retirement classification instead of releasing from %s",
    (received) => {
      const context = fixture();
      enqueue(context);
      const active = admit(context);
      const observation = observe(context, active);
      expect(
        context.retirementOwner.settleObservation(observation, received as unknown as "retired"),
      ).toBe("retained");
      expect(context.lane.snapshot()).toMatchObject({
        state: "quarantined",
        responseAvailable: false,
      });
      expect(context.lane.admitNext()).toEqual({ status: "unavailable", reason: "occupied" });
      expect(context.retirementOwner.settleObservation(observation, "retired")).toBe("unavailable");
    },
  );

  it("refuses stale completions, cancellation and observations after a new admission", () => {
    const context = fixture();
    const oldRequest = enqueue(context);
    const old = admit(context);
    const oldObservation = observe(context, old);
    expect(context.retirementOwner.settleObservation(oldObservation, "retired")).toBe("retired");
    enqueue(context, "viewer");
    const current = admit(context);
    expect(current.owner).not.toBe(old.owner);
    expect(current.lease).not.toBe(old.lease);
    expect(context.lane.complete(old.lease)).toBe("unavailable");
    expect(context.lane.cancel(oldRequest.request)).toBe("unavailable");
    expect(context.retirementOwner.settleObservation(oldObservation, "retired")).toBe(
      "unavailable",
    );
    expect(context.retirementOwner.beginObservation(old.owner, current.lease)).toBeNull();
    expect(context.retirementOwner.beginObservation(current.owner, old.lease)).toBeNull();
    expect(context.retirementOwner.quarantine(old.owner, old.lease)).toBe(false);
    expect(context.lane.canRespond(current.lease)).toBe(true);
  });

  it("cannot clone, serialize or forge reference-identity authority", () => {
    const context = fixture();
    const request = enqueue(context);
    const active = admit(context);
    const observation = observe(context, active);
    const forgedRequest = Object.freeze({}) as VisualizationExecutionRequest;
    const forgedLease = Object.freeze({}) as VisualizationExecutionLease;
    const forgedOwner = Object.freeze({}) as VisualizationExecutionOwner;
    const forgedObservation = Object.freeze({}) as VisualizationRetirementObservation;
    expect(context.lane.cancel(forgedRequest)).toBe("unavailable");
    expect(context.lane.complete(forgedLease)).toBe("unavailable");
    expect(context.retirementOwner.quarantine(forgedOwner, active.lease)).toBe(false);
    expect(context.retirementOwner.beginObservation(active.owner, forgedLease)).toBeNull();
    expect(context.retirementOwner.settleObservation(forgedObservation, "retired")).toBe(
      "unavailable",
    );
    for (const token of [request.request, active.owner, active.lease, observation]) {
      expect(Object.isFrozen(token)).toBe(true);
      expect(JSON.stringify(token)).toBe("{}");
      expect(structuredClone(token)).not.toBe(token);
    }
    expect(context.lane.snapshot().state).toBe("retiring");
  });

  it("does not accept an identity minted by another lane", () => {
    const left = fixture();
    const right = fixture();
    enqueue(left);
    enqueue(right);
    const leftActive = admit(left);
    const rightActive = admit(right);
    const leftObservation = observe(left, leftActive);
    expect(right.lane.complete(leftActive.lease)).toBe("unavailable");
    expect(right.retirementOwner.beginObservation(leftActive.owner, rightActive.lease)).toBeNull();
    expect(right.retirementOwner.settleObservation(leftObservation, "retired")).toBe("unavailable");
    expect(right.lane.canRespond(rightActive.lease)).toBe(true);
  });

  it.each([null, undefined])(
    "refuses absent runtime tokens %s without treating absence as authority",
    (absent) => {
      const context = fixture();
      const request = absent as unknown as VisualizationExecutionRequest;
      const lease = absent as unknown as VisualizationExecutionLease;
      const owner = absent as unknown as VisualizationExecutionOwner;
      const observation = absent as unknown as VisualizationRetirementObservation;
      expect(context.lane.cancel(request)).toBe("unavailable");
      expect(context.lane.complete(lease)).toBe("unavailable");
      expect(context.lane.canRespond(lease)).toBe(false);
      expect(context.retirementOwner.beginObservation(owner, lease)).toBeNull();
      expect(context.retirementOwner.quarantine(owner, lease)).toBe(false);
      expect(context.retirementOwner.settleObservation(observation, "retired")).toBe("unavailable");
      enqueue(context);
      const active = admit(context);
      // No observation has been minted. Null must not match that empty field.
      expect(context.retirementOwner.settleObservation(observation, "retired")).toBe("unavailable");
      expect(context.lane.canRespond(active.lease)).toBe(true);
      const actual = observe(context, active);
      expect(context.retirementOwner.settleObservation(observation, "retired")).toBe("unavailable");
      expect(context.retirementOwner.settleObservation(actual, "retired")).toBe("retired");
      expect(context.lane.complete(lease)).toBe("unavailable");
      expect(context.lane.canRespond(lease)).toBe(false);
      expect(context.retirementOwner.beginObservation(owner, lease)).toBeNull();
      context.lane.close();
      expect(context.lane.cancel(request)).toBe("unavailable");
      expect(context.retirementOwner.quarantine(owner, lease)).toBe(false);
      expect(context.retirementOwner.settleObservation(observation, "retired")).toBe("unavailable");
    },
  );

  it("clamps clock regressions without renewing active or queued deadlines", () => {
    const context = fixture();
    context.setNow(100);
    enqueue(context, "preview", 500);
    const active = admit(context);
    context.setNow(400);
    expect(context.lane.canRespond(active.lease)).toBe(true);
    context.setNow(10);
    const queued = enqueue(context, "viewer", 100);
    expect(queued.deadlineAtMs).toBe(500);
    expect(context.lane.snapshot().activeDeadlineAtMs).toBe(600);
    context.setNow(500);
    expect(context.lane.sweep().waitingCount).toBe(0);
    context.setNow(600);
    expect(context.lane.canRespond(active.lease)).toBe(false);
    context.setNow(0);
    expect(context.lane.canRespond(active.lease)).toBe(false);
    expect(context.lane.snapshot().activeDeadlineAtMs).toBe(600);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, Number.MAX_VALUE])(
    "fails closed for an invalid clock reading %s without freeing an active owner",
    (invalid) => {
      const context = fixture();
      enqueue(context);
      const active = admit(context);
      enqueue(context, "viewer");
      context.setNow(invalid);
      expect(context.lane.canRespond(active.lease)).toBe(false);
      expect(context.lane.snapshot()).toMatchObject({
        state: "quarantined",
        waitingCount: 0,
        responseAvailable: false,
        clockAvailable: false,
        revocation: "clock-unavailable",
      });
      context.setNow(0);
      expect(context.lane.enqueue("viewer", 100)).toEqual({
        status: "refused",
        reason: "clock-unavailable",
      });
      expect(context.lane.admitNext()).toEqual({
        status: "unavailable",
        reason: "clock-unavailable",
      });
      const observation = observe(context, active);
      expect(context.retirementOwner.settleObservation(observation, "retired")).toBe("retired");
      expect(context.lane.snapshot()).toMatchObject({ state: "idle", clockAvailable: false });
    },
  );

  it("invalidates an outstanding observation when the clock becomes unavailable", () => {
    const context = fixture();
    enqueue(context);
    const active = admit(context);
    const stale = observe(context, active);
    context.setNow(Number.NaN);
    expect(context.retirementOwner.settleObservation(stale, "retired")).toBe("unavailable");
    expect(context.lane.snapshot().state).toBe("quarantined");
    const fresh = observe(context, active);
    expect(context.retirementOwner.settleObservation(fresh, "retired")).toBe("retired");
  });

  it("does not expose a throwing clock's private diagnostic", () => {
    const context = fixture();
    enqueue(context);
    const active = admit(context);
    context.readMonotonicMs.mockImplementation(() => {
      throw new Error("private clock payload");
    });
    expect(context.lane.complete(active.lease)).toBe("unavailable");
    expect(JSON.stringify(context.lane.snapshot())).not.toContain("private clock payload");
    expect(context.lane.snapshot().state).toBe("quarantined");
  });

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 20_001])(
    "refuses invalid or oversized budgets %s",
    (budgetMs) => {
      const context = fixture();
      expect(context.lane.enqueue("preview", budgetMs)).toEqual({
        status: "refused",
        reason: "invalid-budget",
      });
      expect(context.lane.snapshot().waitingCount).toBe(0);
    },
  );

  it("accepts the exact finite maximum and refuses deadline arithmetic overflow", () => {
    const context = fixture();
    expect(enqueue(context, "preview", VISUALIZATION_EXECUTION_MAX_BUDGET_MS).deadlineAtMs).toBe(
      20_000,
    );
    context.setNow(Number.MAX_SAFE_INTEGER);
    expect(context.lane.enqueue("preview", 1)).toEqual({
      status: "refused",
      reason: "invalid-budget",
    });
  });

  it("returns fixed source-free classifications and a token-free diagnostic projection", () => {
    const context = fixture();
    const received = "<script>private source</script>" as VisualizationExecutionKind;
    expect(context.lane.enqueue(received, 100)).toEqual({
      status: "refused",
      reason: "invalid-kind",
    });
    enqueue(context);
    const active = admit(context);
    const snapshot = context.lane.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot).toEqual({
      state: "running",
      waitingCount: 0,
      activeKind: "preview",
      responseAvailable: true,
      activeDeadlineAtMs: 1_000,
      nextDeadlineAtMs: 1_000,
      revocation: null,
      closed: false,
      clockAvailable: true,
    });
    expect(Object.values(snapshot)).not.toContain(active.owner);
    expect(Object.values(snapshot)).not.toContain(active.lease);
    expect(JSON.stringify(snapshot)).not.toContain(received);
    expect(Object.keys(context.lane)).not.toContain("settleObservation");
  });

  it("closes idempotently without releasing inconclusive active ownership", () => {
    const context = fixture();
    enqueue(context);
    const active = admit(context);
    enqueue(context, "viewer");
    context.lane.close();
    context.lane.close();
    expect(context.lane.snapshot()).toMatchObject({
      state: "retiring",
      closed: true,
      waitingCount: 0,
    });
    expect(context.lane.canRespond(active.lease)).toBe(false);
    expect(context.lane.enqueue("preview", 100)).toEqual({ status: "refused", reason: "closed" });
    expect(context.lane.admitNext()).toEqual({ status: "unavailable", reason: "closed" });
    const observation = observe(context, active);
    expect(context.retirementOwner.settleObservation(observation, "retired")).toBe("retired");
    expect(context.lane.snapshot()).toMatchObject({ state: "idle", closed: true });
  });

  it("allocates no scheduler timers while exercising a bounded lifecycle", () => {
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const interval = vi.spyOn(globalThis, "setInterval");
    try {
      const context = fixture();
      enqueue(context);
      const active = admit(context);
      context.lane.complete(active.lease);
      context.retirementOwner.settleObservation(observe(context, active), "retired");
      context.lane.close();
      expect(timeout).not.toHaveBeenCalled();
      expect(interval).not.toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
      interval.mockRestore();
    }
  });
});
