import { describe, expect, it } from "vitest";

import type { SavedEnvironmentConnectionLifecycleState } from "./savedEnvironmentConnectionLifecycle";
import {
  beginSavedEnvironmentReconnect,
  recordSavedEnvironmentConnectionAttempt,
  recordSavedEnvironmentConnectionOpened,
  recordSavedEnvironmentManualDisconnect,
  recordSavedEnvironmentRetryScheduled,
  recordSavedEnvironmentTerminalError,
  recordSavedEnvironmentTransportFailure,
} from "./savedEnvironmentConnectionLifecycle";

function makeLifecycle(
  patch: Partial<SavedEnvironmentConnectionLifecycleState> = {},
): SavedEnvironmentConnectionLifecycleState {
  return {
    connectionState: "disconnected",
    connectedAt: null,
    disconnectedAt: null,
    lastError: null,
    lastErrorAt: null,
    nextRetryAt: null,
    reconnectAttemptCount: 0,
    reconnectPhase: "idle",
    ...patch,
  };
}

function applyPatch(
  current: SavedEnvironmentConnectionLifecycleState,
  patch: Partial<SavedEnvironmentConnectionLifecycleState>,
): SavedEnvironmentConnectionLifecycleState {
  return { ...current, ...patch };
}

describe("saved environment connection lifecycle", () => {
  it("counts a manually requested reconnect and its socket callback once", () => {
    const requested = applyPatch(makeLifecycle(), beginSavedEnvironmentReconnect(makeLifecycle()));
    const attempted = applyPatch(requested, recordSavedEnvironmentConnectionAttempt(requested));

    expect(attempted).toMatchObject({
      connectionState: "connecting",
      reconnectAttemptCount: 1,
      reconnectPhase: "attempting",
    });
  });

  it("keeps the error-close pair on one waiting decision", () => {
    const attempted = applyPatch(
      makeLifecycle(),
      recordSavedEnvironmentConnectionAttempt(makeLifecycle()),
    );
    const errored = applyPatch(
      attempted,
      recordSavedEnvironmentTransportFailure(attempted, {
        message: "Connection failed.",
        nowMs: 1_000,
      }),
    );
    const closed = applyPatch(
      errored,
      recordSavedEnvironmentTransportFailure(errored, {
        message: "Connection closed unexpectedly.",
        nowMs: 1_100,
      }),
    );

    expect(closed).toMatchObject({
      connectionState: "disconnected",
      lastError: "Connection failed.",
      nextRetryAt: "1970-01-01T00:00:02.000Z",
      reconnectAttemptCount: 1,
      reconnectPhase: "waiting",
    });
  });

  it("keeps retrying prolonged outages at the capped delay", () => {
    let current = makeLifecycle();
    const delays = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000];
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      current = applyPatch(current, recordSavedEnvironmentConnectionAttempt(current));
      current = applyPatch(
        current,
        recordSavedEnvironmentTransportFailure(current, {
          message: "Connection failed.",
          nowMs: attempt * 100_000,
        }),
      );

      expect(current.reconnectAttemptCount).toBe(attempt);
      expect(current.reconnectPhase).toBe("waiting");
      expect(current.nextRetryAt).toBe(
        new Date(attempt * 100_000 + delays[Math.min(attempt - 1, 6)]!).toISOString(),
      );
    }

    expect(current).toMatchObject({
      connectionState: "disconnected",
      nextRetryAt: new Date(1_264_000).toISOString(),
      reconnectAttemptCount: 12,
      reconnectPhase: "waiting",
    });
  });

  it("uses the actual protocol schedule after an open without a healthy heartbeat", () => {
    const opened = applyPatch(
      makeLifecycle(),
      recordSavedEnvironmentConnectionOpened("2026-09-01T12:00:00.000Z"),
    );
    const waiting = applyPatch(
      opened,
      recordSavedEnvironmentRetryScheduled({
        retryIndex: 9,
        nextRetryAt: "2026-09-01T12:01:04.000Z",
      }),
    );
    expect(waiting).toMatchObject({
      connectionState: "disconnected",
      reconnectAttemptCount: 10,
      reconnectPhase: "waiting",
      nextRetryAt: "2026-09-01T12:01:04.000Z",
    });
  });

  it("tracks a post-connect heartbeat loss as waiting for a new attempt", () => {
    const connected = applyPatch(
      makeLifecycle(),
      recordSavedEnvironmentConnectionOpened("2026-09-01T12:00:00.000Z"),
    );
    const failed = applyPatch(
      connected,
      recordSavedEnvironmentTransportFailure(connected, {
        message: "Heartbeat timed out.",
        nowMs: Date.parse("2026-09-01T12:00:05.000Z"),
      }),
    );

    expect(failed).toMatchObject({
      connectionState: "disconnected",
      reconnectAttemptCount: 1,
      reconnectPhase: "waiting",
      nextRetryAt: "2026-09-01T12:00:06.000Z",
    });
  });

  it("resets an exhausted cycle when the user retries", () => {
    const exhausted = makeLifecycle({
      connectionState: "error",
      reconnectAttemptCount: 8,
      reconnectPhase: "exhausted",
    });

    expect(applyPatch(exhausted, beginSavedEnvironmentReconnect(exhausted))).toMatchObject({
      connectionState: "connecting",
      reconnectAttemptCount: 1,
      reconnectPhase: "attempting",
    });
  });

  it("distinguishes an intentional stop from exhausted retries", () => {
    expect(
      applyPatch(
        makeLifecycle({ reconnectAttemptCount: 3, reconnectPhase: "waiting" }),
        recordSavedEnvironmentManualDisconnect("2026-09-01T12:00:00.000Z"),
      ),
    ).toMatchObject({
      connectionState: "disconnected",
      reconnectAttemptCount: 0,
      reconnectPhase: "idle",
    });

    expect(
      applyPatch(
        makeLifecycle(),
        recordSavedEnvironmentTerminalError({
          message: "Credential expired.",
          occurredAt: "2026-09-01T12:00:00.000Z",
        }),
      ),
    ).toMatchObject({
      connectionState: "error",
      lastError: "Credential expired.",
      reconnectPhase: "exhausted",
    });
  });
});
