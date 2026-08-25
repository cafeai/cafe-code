/**
 * Durable evidence that a specific ProviderService process still owns a live
 * provider session.
 *
 * Provider session rows are shared by the desktop backend, detached provider
 * daemon, and optional web/dev backends. A `status = running` row by itself is
 * therefore not liveness evidence: it can outlive a crashed daemon. The owner
 * incarnation prevents two Cafe runtimes from accidentally presenting the
 * same lease, the heartbeat bounds stale evidence, and the PID probe rejects
 * a recently crashed owner before the heartbeat window expires.
 *
 * The owner id is collision-resistant metadata, not a bearer secret. It must
 * never be used as authentication for the provider daemon transport.
 */

export interface ProviderRuntimeOwnerEvidence {
  readonly runtimeOwnerId: string;
  readonly runtimeOwnerPid: number;
  readonly runtimeOwnerStartedAt: string;
  readonly runtimeOwnerHeartbeatAt: string;
}

export const PROVIDER_RUNTIME_OWNER_HEARTBEAT_INTERVAL_MS = 60_000;
export const PROVIDER_RUNTIME_OWNER_MAX_HEARTBEAT_AGE_MS = 3 * 60_000;
export const PROVIDER_RUNTIME_OWNER_MAX_FUTURE_SKEW_MS = 60_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 does not terminate the process. It asks the operating system to
    // validate that this process id currently exists and is signal-addressable.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM still proves that the process exists; it only means this process
    // cannot signal it. ESRCH and every other failure are not liveness proof.
    return (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "EPERM"
    );
  }
}

export function makeProviderRuntimeOwnerPayload(
  owner: Omit<ProviderRuntimeOwnerEvidence, "runtimeOwnerHeartbeatAt">,
  runtimeOwnerHeartbeatAt: string,
): ProviderRuntimeOwnerEvidence {
  return {
    ...owner,
    runtimeOwnerHeartbeatAt,
  };
}

export function hasLiveProviderRuntimeOwner(payload: unknown, observedAtMs: number): boolean {
  if (!isRecord(payload)) {
    return false;
  }

  const ownerId = payload.runtimeOwnerId;
  const ownerPid = payload.runtimeOwnerPid;
  const ownerStartedAt = payload.runtimeOwnerStartedAt;
  const ownerHeartbeatAt = payload.runtimeOwnerHeartbeatAt;
  if (
    typeof ownerId !== "string" ||
    !UUID_PATTERN.test(ownerId) ||
    typeof ownerPid !== "number" ||
    !Number.isSafeInteger(ownerPid) ||
    ownerPid <= 0 ||
    typeof ownerStartedAt !== "string" ||
    typeof ownerHeartbeatAt !== "string"
  ) {
    return false;
  }

  const startedAtMs = Date.parse(ownerStartedAt);
  const heartbeatAtMs = Date.parse(ownerHeartbeatAt);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(heartbeatAtMs)) {
    return false;
  }

  // Reject malformed or future-dated leases before probing an arbitrary PID.
  // A small skew allowance covers wall-clock adjustment across Cafe processes.
  if (
    startedAtMs > observedAtMs + PROVIDER_RUNTIME_OWNER_MAX_FUTURE_SKEW_MS ||
    heartbeatAtMs > observedAtMs + PROVIDER_RUNTIME_OWNER_MAX_FUTURE_SKEW_MS ||
    heartbeatAtMs + PROVIDER_RUNTIME_OWNER_MAX_FUTURE_SKEW_MS < startedAtMs ||
    observedAtMs - heartbeatAtMs > PROVIDER_RUNTIME_OWNER_MAX_HEARTBEAT_AGE_MS
  ) {
    return false;
  }

  return isProcessAlive(ownerPid);
}
