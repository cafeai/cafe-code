import { describe, expect, it } from "vitest";
import type { SavedEnvironmentRuntimeState } from "../../environments/runtime";

import { resolveSavedEnvironmentConnectionIssue } from "./ConnectionStatusIndicator.logic";

function makeRuntime(
  patch: Partial<SavedEnvironmentRuntimeState> = {},
): SavedEnvironmentRuntimeState {
  return {
    connectionState: "connected",
    authState: "authenticated",
    lastError: null,
    lastErrorAt: null,
    role: null,
    descriptor: null,
    serverConfig: null,
    connectedAt: "2026-09-01T12:00:00.000Z",
    disconnectedAt: null,
    nextRetryAt: null,
    reconnectAttemptCount: 0,
    reconnectPhase: "idle",
    ...patch,
  };
}

describe("ConnectionStatusIndicator logic", () => {
  it("stays hidden for a connected saved environment", () => {
    expect(
      resolveSavedEnvironmentConnectionIssue({
        runtime: makeRuntime(),
        browserOnline: true,
      }),
    ).toBeNull();
  });

  it("surfaces a genuine saved-environment disconnect as reconnecting", () => {
    expect(
      resolveSavedEnvironmentConnectionIssue({
        runtime: makeRuntime({
          connectionState: "disconnected",
          disconnectedAt: "2026-09-01T12:01:00.000Z",
          nextRetryAt: "2026-09-01T12:01:01.000Z",
          reconnectAttemptCount: 1,
          reconnectPhase: "waiting",
        }),
        browserOnline: true,
      }),
    ).toBe("reconnecting");
  });

  it("surfaces a saved-environment retry failure as exhausted", () => {
    expect(
      resolveSavedEnvironmentConnectionIssue({
        runtime: makeRuntime({
          connectionState: "error",
          lastError: "Connection failed.",
          reconnectAttemptCount: 8,
          reconnectPhase: "exhausted",
        }),
        browserOnline: true,
      }),
    ).toBe("exhausted");
  });

  it("gives browser offline state precedence after a saved connection is lost", () => {
    expect(
      resolveSavedEnvironmentConnectionIssue({
        runtime: makeRuntime({ connectionState: "disconnected", reconnectPhase: "waiting" }),
        browserOnline: false,
      }),
    ).toBe("offline");
  });

  it("does not show reconnecting during a saved environment's first connection", () => {
    expect(
      resolveSavedEnvironmentConnectionIssue({
        runtime: makeRuntime({ connectionState: "connecting", connectedAt: null }),
        browserOnline: true,
      }),
    ).toBeNull();
  });

  it("surfaces a saved environment failure before its first successful connection", () => {
    expect(
      resolveSavedEnvironmentConnectionIssue({
        runtime: makeRuntime({
          connectionState: "error",
          connectedAt: null,
          lastError: "Connection failed.",
          lastErrorAt: "2026-09-01T12:01:00.000Z",
          reconnectAttemptCount: 8,
          reconnectPhase: "exhausted",
        }),
        browserOnline: true,
      }),
    ).toBe("exhausted");
  });

  it("does not mislabel an intentional disconnect as an active reconnect", () => {
    expect(
      resolveSavedEnvironmentConnectionIssue({
        runtime: makeRuntime({
          connectionState: "disconnected",
          disconnectedAt: "2026-09-01T12:01:00.000Z",
          reconnectPhase: "idle",
        }),
        browserOnline: true,
      }),
    ).toBe("disconnected");
  });

  it("keeps exhausted state after a browser close follows the error", () => {
    expect(
      resolveSavedEnvironmentConnectionIssue({
        runtime: makeRuntime({
          connectionState: "disconnected",
          disconnectedAt: "2026-09-01T12:01:00.000Z",
          reconnectAttemptCount: 8,
          reconnectPhase: "exhausted",
        }),
        browserOnline: true,
      }),
    ).toBe("exhausted");
  });
});
