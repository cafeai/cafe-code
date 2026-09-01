import type { SavedEnvironmentRuntimeState } from "../../environments/runtime";

export type ConnectionIssue = "reconnecting" | "offline" | "exhausted" | "disconnected";

/**
 * Resolve the connection issue for a saved environment without consulting the
 * primary WebSocket singleton. Initial saved-environment startup stays quiet,
 * matching the primary bootstrap surface. A failed first attempt and every
 * post-connect loss remain visible until the scoped transport opens again.
 */
export function resolveSavedEnvironmentConnectionIssue(input: {
  readonly runtime: SavedEnvironmentRuntimeState | undefined;
  readonly browserOnline: boolean;
}): ConnectionIssue | null {
  const runtime = input.runtime;
  if (runtime === undefined || runtime.connectionState === "connected") {
    return null;
  }

  const hasNoConnectionOutcome =
    runtime.connectedAt === null && runtime.disconnectedAt === null && runtime.lastErrorAt === null;
  if (hasNoConnectionOutcome) {
    return null;
  }

  if (!input.browserOnline && runtime.reconnectPhase !== "idle") {
    return "offline";
  }

  switch (runtime.reconnectPhase) {
    case "attempting":
    case "waiting":
      return "reconnecting";
    case "exhausted":
      return "exhausted";
    case "idle":
      return runtime.connectionState === "error" ? "exhausted" : "disconnected";
  }
}
