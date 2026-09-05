import { describe, expect, it } from "vitest";

import type { SavedEnvironmentConnectionLifecycleState } from "./savedEnvironmentConnectionLifecycle";
import {
  beginSavedEnvironmentReconnect,
  recordSavedEnvironmentConnectionAttempt,
  recordSavedEnvironmentConnectionOpened,
  recordSavedEnvironmentManualDisconnect,
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

  it("becomes exhausted only after the transport's eighth failed attempt", () => {
    let current = makeLifecycle();
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      current = applyPatch(current, recordSavedEnvironmentConnectionAttempt(current));
      current = applyPatch(
        current,
        recordSavedEnvironmentTransportFailure(current, {
          message: "Connection failed.",
          nowMs: attempt * 100_000,
        }),
      );

      expect(current.reconnectAttemptCount).toBe(attempt);
      expect(current.reconnectPhase).toBe(attempt === 8 ? "exhausted" : "waiting");
    }

    expect(current).toMatchObject({
      connectionState: "error",
      nextRetryAt: null,
      reconnectAttemptCount: 8,
      reconnectPhase: "exhausted",
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
