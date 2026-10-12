/**
 * Bounded, process-local admission and retirement bookkeeping for visual work.
 *
 * This module does not launch, stop, sandbox or qualify an execution host. Its
 * private retirement controller belongs only to a trusted lifecycle owner that
 * independently observes actual retirement. It must never be handed to a page,
 * renderer action dispatcher or RPC endpoint. A controller call is coordination,
 * not evidence that a kernel container or an entire process tree has retired.
 *
 * The application must share one owning lane across previews and viewers when
 * enforcing a global allowance. Creating one lane per window/job defeats that
 * allowance. There are deliberately no timers, promises, source bytes or job
 * callbacks here: an external watchdog must drive sweep and native retirement.
 * In-process bookkeeping cannot preempt JavaScript or contain native resources.
 */

export const VISUALIZATION_EXECUTION_MAX_WAITING = 2;
export const VISUALIZATION_EXECUTION_MAX_BUDGET_MS = 20_000;

declare const requestBrand: unique symbol;
declare const ownerBrand: unique symbol;
declare const leaseBrand: unique symbol;
declare const observationBrand: unique symbol;

/** Opaque tokens are valid only by their original process-local object identity. */
export type VisualizationExecutionRequest = Readonly<{ [requestBrand]: true }>;
export type VisualizationExecutionOwner = Readonly<{ [ownerBrand]: true }>;
export type VisualizationExecutionLease = Readonly<{ [leaseBrand]: true }>;
export type VisualizationRetirementObservation = Readonly<{ [observationBrand]: true }>;

export type VisualizationExecutionKind = "preview" | "viewer";
export type VisualizationExecutionState = "idle" | "running" | "retiring" | "quarantined";
export type VisualizationExecutionRevocation =
  | "cancelled"
  | "completed"
  | "deadline"
  | "closed"
  | "clock-unavailable"
  | "owner-retirement"
  | "uncertain-retirement";

export interface VisualizationExecutionAdmission {
  readonly request: VisualizationExecutionRequest;
  readonly owner: VisualizationExecutionOwner;
  readonly lease: VisualizationExecutionLease;
  readonly kind: VisualizationExecutionKind;
  /** Fixed at enqueue: startup, waiting and execution consume the same budget. */
  readonly deadlineAtMs: number;
}

export type VisualizationExecutionEnqueueResult =
  | Readonly<{
      status: "queued";
      request: VisualizationExecutionRequest;
      deadlineAtMs: number;
    }>
  | Readonly<{
      status: "refused";
      reason: "invalid-kind" | "invalid-budget" | "saturated" | "closed" | "clock-unavailable";
    }>;

export type VisualizationExecutionAdmitResult =
  | Readonly<{ status: "admitted"; admission: VisualizationExecutionAdmission }>
  | Readonly<{
      status: "unavailable";
      reason: "empty" | "occupied" | "closed" | "clock-unavailable";
    }>;

/** This diagnostic projection deliberately excludes tokens, payloads and errors. */
export interface VisualizationExecutionLaneSnapshot {
  readonly state: VisualizationExecutionState;
  readonly waitingCount: number;
  readonly activeKind: VisualizationExecutionKind | null;
  readonly responseAvailable: boolean;
  readonly activeDeadlineAtMs: number | null;
  readonly nextDeadlineAtMs: number | null;
  readonly revocation: VisualizationExecutionRevocation | null;
  readonly closed: boolean;
  readonly clockAvailable: boolean;
}

export interface VisualizationExecutionLane {
  readonly enqueue: (
    kind: VisualizationExecutionKind,
    budgetMs: number,
  ) => VisualizationExecutionEnqueueResult;
  /** Admission is explicit; clearing retirement never starts another job itself. */
  readonly admitNext: () => VisualizationExecutionAdmitResult;
  readonly cancel: (
    request: VisualizationExecutionRequest,
  ) => "queued-cancelled" | "retirement-required" | "unavailable";
  /**
   * Accept one timely result, then revoke response authority and retain the slot.
   * Deliver that result only when this returns accepted; never store bytes here.
   */
  readonly complete: (lease: VisualizationExecutionLease) => "accepted" | "unavailable";
  readonly canRespond: (lease: VisualizationExecutionLease) => boolean;
  readonly sweep: () => VisualizationExecutionLaneSnapshot;
  readonly snapshot: () => VisualizationExecutionLaneSnapshot;
  /** Stop accepting work and cancel all waiting work; active retirement remains. */
  readonly close: () => void;
}

/**
 * Private capability for the future trusted native lifecycle owner, not a public
 * result/ACK decoder. It must bind fresh native evidence to the exact owner and
 * lease before reporting an observation. No page-supplied success flag qualifies.
 */
export interface VisualizationExecutionRetirementOwner {
  readonly beginObservation: (
    owner: VisualizationExecutionOwner,
    lease: VisualizationExecutionLease,
  ) => VisualizationRetirementObservation | null;
  readonly settleObservation: (
    observation: VisualizationRetirementObservation,
    result: "retired" | "running" | "uncertain",
  ) => "retired" | "retained" | "unavailable";
  /** Lost stop/observation responses invalidate any outstanding acknowledgement. */
  readonly quarantine: (
    owner: VisualizationExecutionOwner,
    lease: VisualizationExecutionLease,
  ) => boolean;
}

interface WaitingRequest {
  readonly request: VisualizationExecutionRequest;
  readonly kind: VisualizationExecutionKind;
  readonly deadlineAtMs: number;
}

interface ActiveRequest {
  readonly admission: VisualizationExecutionAdmission;
  state: Exclude<VisualizationExecutionState, "idle">;
  revocation: VisualizationExecutionRevocation | null;
  observation: VisualizationRetirementObservation | null;
}

/**
 * Construct one bounded lane and a separately retained trusted-owner capability.
 *
 * `readMonotonicMs` is trusted clock plumbing, not a provider/page callback. A
 * finite backwards reading clamps to the observed high-water mark, never renews
 * an existing deadline. A throwing/nonfinite/negative clock permanently refuses
 * new work and quarantines any active owner; exact retirement can still finish.
 * Recovery requires a new trusted lane only AFTER the old owner's conclusive
 * retirement, not a reset that forgets an inconclusive process.
 */
export function createVisualizationExecutionLane(options: {
  readonly readMonotonicMs: () => number;
}): Readonly<{
  lane: VisualizationExecutionLane;
  retirementOwner: VisualizationExecutionRetirementOwner;
}> {
  const readMonotonicMs = options.readMonotonicMs;
  // Retain at most two waiting records, one admitted record and one observation.
  // Retired/cancelled/expired identities are not accumulated in a history map.
  let waiting: WaitingRequest[] = [];
  let active: ActiveRequest | null = null;
  let highWaterMs = 0;
  let clockUnavailable = false;
  let closed = false;

  const revoke = (reason: VisualizationExecutionRevocation): void => {
    if (active === null) return;
    if (active.state === "running") {
      active.state = "retiring";
      active.revocation = reason;
    }
  };

  const quarantine = (reason: VisualizationExecutionRevocation): void => {
    if (active === null) return;
    active.state = "quarantined";
    active.revocation = reason;
    // A lost response cannot later act as a fresh retirement observation.
    active.observation = null;
  };

  const refresh = (): number | null => {
    if (clockUnavailable) return null;
    let observedMs: number;
    try {
      observedMs = readMonotonicMs();
    } catch {
      // Exceptions are intentionally not retained, rendered or serialized.
      observedMs = Number.NaN;
    }
    if (!Number.isFinite(observedMs) || observedMs < 0 || observedMs > Number.MAX_SAFE_INTEGER) {
      clockUnavailable = true;
      waiting = [];
      quarantine("clock-unavailable");
      return null;
    }

    highWaterMs = Math.max(highWaterMs, observedMs);
    waiting = waiting.filter((item) => item.deadlineAtMs > highWaterMs);
    if (active !== null && active.admission.deadlineAtMs <= highWaterMs) {
      revoke("deadline");
    }
    return highWaterMs;
  };

  const matches = (
    owner: VisualizationExecutionOwner,
    lease: VisualizationExecutionLease,
  ): boolean =>
    active !== null && active.admission.owner === owner && active.admission.lease === lease;

  const project = (): VisualizationExecutionLaneSnapshot => {
    // A retiring deadline is not a reason to release or spin a renewed timer.
    const deadlines = waiting.map((item) => item.deadlineAtMs);
    if (active?.state === "running") deadlines.push(active.admission.deadlineAtMs);
    return Object.freeze({
      state: active?.state ?? "idle",
      waitingCount: waiting.length,
      activeKind: active?.admission.kind ?? null,
      responseAvailable: active?.state === "running",
      activeDeadlineAtMs: active?.admission.deadlineAtMs ?? null,
      nextDeadlineAtMs: deadlines.length === 0 ? null : Math.min(...deadlines),
      revocation: active?.revocation ?? null,
      closed,
      clockAvailable: !clockUnavailable,
    });
  };

  const snapshot = (): VisualizationExecutionLaneSnapshot => {
    refresh();
    return project();
  };

  const lane = Object.freeze<VisualizationExecutionLane>({
    enqueue: (kind, budgetMs) => {
      const nowMs = refresh();
      if (closed) return Object.freeze({ status: "refused", reason: "closed" });
      if (nowMs === null) {
        return Object.freeze({ status: "refused", reason: "clock-unavailable" });
      }
      if (kind !== "preview" && kind !== "viewer") {
        return Object.freeze({ status: "refused", reason: "invalid-kind" });
      }
      if (
        !Number.isSafeInteger(budgetMs) ||
        budgetMs < 1 ||
        budgetMs > VISUALIZATION_EXECUTION_MAX_BUDGET_MS ||
        nowMs + budgetMs > Number.MAX_SAFE_INTEGER
      ) {
        return Object.freeze({ status: "refused", reason: "invalid-budget" });
      }
      if (waiting.length >= VISUALIZATION_EXECUTION_MAX_WAITING) {
        return Object.freeze({ status: "refused", reason: "saturated" });
      }

      // Object identity cannot be recreated by parsing JSON, guessing a counter
      // or copying object properties. Tokens carry no serializable authority.
      const request = Object.freeze({}) as VisualizationExecutionRequest;
      const deadlineAtMs = nowMs + budgetMs;
      waiting.push({ request, kind, deadlineAtMs });
      return Object.freeze({ status: "queued", request, deadlineAtMs });
    },
    admitNext: () => {
      const nowMs = refresh();
      if (closed) return Object.freeze({ status: "unavailable", reason: "closed" });
      if (nowMs === null) {
        return Object.freeze({ status: "unavailable", reason: "clock-unavailable" });
      }
      if (active !== null) return Object.freeze({ status: "unavailable", reason: "occupied" });
      const next = waiting.shift();
      if (next === undefined) return Object.freeze({ status: "unavailable", reason: "empty" });

      const admission = Object.freeze({
        ...next,
        owner: Object.freeze({}) as VisualizationExecutionOwner,
        lease: Object.freeze({}) as VisualizationExecutionLease,
      });
      active = { admission, state: "running", revocation: null, observation: null };
      return Object.freeze({ status: "admitted", admission });
    },
    cancel: (request) => {
      refresh();
      const index = waiting.findIndex((item) => item.request === request);
      if (index !== -1) {
        waiting.splice(index, 1);
        return "queued-cancelled";
      }
      if (active === null || active.admission.request !== request) return "unavailable";
      revoke("cancelled");
      return "retirement-required";
    },
    complete: (lease) => {
      refresh();
      if (active === null || active.admission.lease !== lease || active.state !== "running") {
        return "unavailable";
      }
      revoke("completed");
      return "accepted";
    },
    canRespond: (lease) => {
      refresh();
      return active !== null && active.admission.lease === lease && active.state === "running";
    },
    sweep: snapshot,
    snapshot,
    close: () => {
      refresh();
      closed = true;
      waiting = [];
      revoke("closed");
    },
  });

  const retirementOwner = Object.freeze<VisualizationExecutionRetirementOwner>({
    beginObservation: (owner, lease) => {
      refresh();
      if (!matches(owner, lease) || active === null || active.observation !== null) return null;
      // The owner may begin retirement after unexpected native exit as well as
      // after normal completion/cancel. Beginning revokes response immediately.
      revoke("owner-retirement");
      const observation = Object.freeze({}) as VisualizationRetirementObservation;
      active.observation = observation;
      return observation;
    },
    settleObservation: (observation, result) => {
      refresh();
      if (active === null || active.observation === null || active.observation !== observation) {
        return "unavailable";
      }
      active.observation = null;
      if (result === "retired") {
        // Only the separate trusted owner can assert its fresh native evidence.
        // No public completion, timeout or cancellation reaches this transition.
        active = null;
        return "retired";
      }
      if (result !== "running") quarantine("uncertain-retirement");
      // Positive liveness does not clear an already quarantined owner either.
      return "retained";
    },
    quarantine: (owner, lease) => {
      refresh();
      if (!matches(owner, lease)) return false;
      quarantine("uncertain-retirement");
      return true;
    },
  });

  return Object.freeze({ lane, retirementOwner });
}
