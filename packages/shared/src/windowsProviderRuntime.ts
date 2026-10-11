// @effect-diagnostics nodeBuiltinImport:off
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import * as Schema from "effect/Schema";
import {
  PROVIDER_DAEMON_HEALTH_PATH,
  PROVIDER_DAEMON_LEASES_PATH,
  ProviderDaemonHealth,
  ProviderDaemonLeaseResponse,
  ProviderDaemonMarker,
  type ProviderDaemonBootstrap,
  type ProviderDaemonClientConfig,
  type ProviderRuntimeProcessMode,
} from "@cafecode/contracts";
import { requestProviderDaemonJson } from "./providerDaemonHttp.ts";
import {
  BACKEND_STARTUP_PROGRESS_FD,
  makeProviderDaemonStartupProgressTracker,
  type ProviderDaemonStartupProgress,
} from "./backendStartupProgress.ts";
import {
  openWindowsOwnershipSession,
  windowsOwnershipCredentialPath,
  WindowsOwnershipError,
  type WindowsOwnershipReason,
  type WindowsOwnershipSession,
  type WindowsOwnershipSnapshot,
  type WindowsProcessIdentity,
} from "./windowsProcessOwnership.ts";

/** Fixed diagnostic vocabulary; native output, credentials and paths never escape. */
export type WindowsProviderRuntimeFailure =
  | "ownership-unavailable"
  | "invalid-record"
  | "credential-unavailable"
  | "identity-unknown"
  | "legacy-identity-unknown"
  | "endpoint-unavailable"
  | "endpoint-conflict"
  | "lease-unavailable"
  | "ownership-changed"
  | "mutation-uncertain"
  | "prepared-attempt-uncertain"
  | "child-admission-uncertain"
  | "upstream-ownership-unknown"
  | "termination-uncertain";

export class WindowsProviderRuntimeError extends Error {
  readonly reason: WindowsProviderRuntimeFailure;
  readonly nativeReason?: WindowsOwnershipReason;
  constructor(reason: WindowsProviderRuntimeFailure, nativeReason?: WindowsOwnershipReason) {
    super(
      reason === "legacy-identity-unknown"
        ? "Existing Windows runtime has no verified process identity. Its ownership was preserved; retry connection or use guided legacy recovery."
        : `Windows runtime ownership is inconclusive (${reason}${nativeReason === undefined ? "" : `: ${nativeReason}`}); existing processes and recovery evidence were preserved. Retry connection.`,
    );
    this.name = "WindowsProviderRuntimeError";
    this.reason = reason;
    if (nativeReason !== undefined) this.nativeReason = nativeReason;
  }
}

export interface WindowsRuntimeChild {
  readonly pid: number;
  /** An actual direct-child exit event, never a new PID lookup. */
  readonly hasExited: () => boolean;
  /** Retire only the inherited progress read handle, never the child process. */
  readonly closeStartupProgress?: () => void;
}

export interface WindowsRuntimeStartupProgress {
  readonly tracker: ReturnType<typeof makeProviderDaemonStartupProgressTracker>;
  readonly elapsedMs: () => number;
}

export interface WindowsProviderRuntimeResult {
  readonly endpoint: ProviderDaemonClientConfig;
  readonly rootEndpoint: ProviderDaemonClientConfig;
  readonly marker: ProviderDaemonMarker;
  readonly health: ProviderDaemonHealth;
  readonly adopted: boolean;
  /** Generation or legacy revision, deliberately opaque to watchdog callers. */
  readonly ownershipId: string;
}

export interface WindowsProviderRuntimeObservation {
  readonly status: "same-process" | "exited" | "different-process" | "unknown";
  readonly ownershipId?: string;
}

export interface WindowsProviderRuntimeOptions {
  readonly role: ProviderRuntimeProcessMode;
  readonly markerPath: string;
  readonly legacyCredentialPath: string;
  readonly socketPath: string;
  readonly appVersion: string;
  readonly protocolVersion: number;
  readonly runtimeBuildId?: string;
  readonly cafeMcpPort?: () => number | undefined;
  readonly bootstrap: Omit<
    ProviderDaemonBootstrap,
    "mode" | "transport" | "socketPath" | "token" | "runtimeBuildId" | "windowsOwnershipId"
  >;
  readonly encodeCredential: (token: string) => Promise<{
    readonly base64: string;
    readonly encrypted: boolean;
  }>;
  readonly decodeCredential: (base64: string, encrypted: boolean) => Promise<string>;
  readonly spawn: (
    bootstrap: ProviderDaemonBootstrap,
    startupProgress?: WindowsRuntimeStartupProgress,
  ) => Promise<WindowsRuntimeChild>;
  readonly onStartupProgress?: (progress: ProviderDaemonStartupProgress) => void;
  readonly fetchHealth?: (endpoint: ProviderDaemonClientConfig) => Promise<ProviderDaemonHealth>;
  readonly issueLease?: (
    endpoint: ProviderDaemonClientConfig,
  ) => Promise<ProviderDaemonLeaseResponse>;
  readonly openSession?: typeof openWindowsOwnershipSession;
  /** Called only after releasing this role's guard; independently verifies the other role. */
  readonly stopSupervisor?: (owner: {
    readonly ownershipId: string;
    readonly identity: WindowsProcessIdentity;
  }) => Promise<void>;
  /** Tests inject time; production deadlines remain bounded, without inference retries. */
  readonly now?: () => number;
  readonly monotonicNow?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly readinessTimeoutMs?: number;
}

export interface WindowsProviderRuntime {
  readonly ensure: () => Promise<WindowsProviderRuntimeResult>;
  readonly observe: () => Promise<WindowsProviderRuntimeObservation>;
  readonly stop: (
    expectedOwnershipId?: string,
    expectedIdentity?: WindowsProcessIdentity,
  ) => Promise<void>;
  readonly recover: (expectedOwnershipId?: string) => Promise<WindowsProviderRuntimeResult>;
  readonly current: () => WindowsProviderRuntimeResult | null;
}

/**
 * Launch a detached child without a scope finalizer that can later kill a recycled
 * PID. Bootstrap is private descriptor data; no token is added to argv or env.
 * A failed descriptor write is deliberately NOT turned into a kill/retry: the
 * runtime controller retains its prepared ownership record until actual exit or
 * authenticated admission proves what happened to this child.
 */
export async function spawnWindowsProviderRuntimeChild(options: {
  readonly executable: string;
  readonly entrypoint: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly bootstrap: ProviderDaemonBootstrap;
  readonly startupProgress?: WindowsRuntimeStartupProgress;
  readonly spawnChild?: typeof spawn;
}): Promise<WindowsRuntimeChild> {
  const child = (options.spawnChild ?? spawn)(
    options.executable,
    [options.entrypoint, options.bootstrap.mode, "--bootstrap-fd", "3"],
    {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
    } satisfies SpawnOptions,
  );
  let exited = false;
  let progressClosed = false;
  const progressPipe = child.stdio[4];
  const closeStartupProgress = () => {
    if (progressClosed) return;
    progressClosed = true;
    options.startupProgress?.tracker.end();
    progressPipe?.destroy();
  };
  // Install flowing reads before awaiting spawn: a quick child can emit its
  // migration start immediately. Keep draining even after decoder rejection,
  // and keep detached stdout/stderr independent of the desktop lifetime.
  progressPipe?.on("data", (bytes: Buffer) => {
    if (!progressClosed)
      options.startupProgress?.tracker.push(bytes, options.startupProgress.elapsedMs());
  });
  progressPipe?.on("end", () => options.startupProgress?.tracker.end());
  // An I/O failure is not a clean EOF: revoke any uncompleted allowance even
  // when the last accepted frame ended on a complete line boundary.
  progressPipe?.on("error", () => options.startupProgress?.tracker.invalidate());
  if (progressPipe && "unref" in progressPipe && typeof progressPipe.unref === "function")
    progressPipe.unref();
  child.once("exit", () => {
    exited = true;
    closeStartupProgress();
  });
  // Keep a listener after launch too: subsequent spawn/stdio errors contain
  // machine-specific data and cannot become unhandled diagnostic disclosures.
  child.on("error", () => {});
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", () =>
        reject(new WindowsProviderRuntimeError("child-admission-uncertain")),
      );
    });
  } catch (error) {
    closeStartupProgress();
    throw error;
  }
  const pipe = child.stdio[3];
  if (pipe && "write" in pipe) {
    pipe.on("error", () => {});
    try {
      pipe.end(`${JSON.stringify(options.bootstrap)}\n`);
    } catch {
      // Keep the real child handle for exit observation after a partial write.
    }
    if ("unref" in pipe && typeof pipe.unref === "function") pipe.unref();
  }
  child.unref();
  if (child.pid === undefined) {
    closeStartupProgress();
    throw new WindowsProviderRuntimeError("child-admission-uncertain");
  }
  return { pid: child.pid, hasExited: () => exited, closeStartupProgress };
}

const fail = (reason: WindowsProviderRuntimeFailure, nativeError?: unknown): never => {
  throw new WindowsProviderRuntimeError(
    reason,
    nativeError instanceof WindowsOwnershipError ? nativeError.reason : undefined,
  );
};
const sameIdentity = (a: WindowsProcessIdentity, b: WindowsProcessIdentity): boolean =>
  a.pid === b.pid && a.creationTime100ns === b.creationTime100ns;
const decodeMarker = Schema.decodeUnknownSync(ProviderDaemonMarker);
const decodeHealth = Schema.decodeUnknownSync(ProviderDaemonHealth);
const decodeLease = Schema.decodeUnknownSync(ProviderDaemonLeaseResponse);

async function readHealth(endpoint: ProviderDaemonClientConfig): Promise<ProviderDaemonHealth> {
  const response = await requestProviderDaemonJson(endpoint, PROVIDER_DAEMON_HEALTH_PATH, {
    timeoutMs: 3_000,
    signal: AbortSignal.timeout(3_000),
    maxResponseBytes: 1_048_576,
  });
  if (response.statusCode !== 200) return fail("endpoint-unavailable");
  return decodeHealth(JSON.parse(response.body));
}

function defaultLease(role: ProviderRuntimeProcessMode) {
  return async (endpoint: ProviderDaemonClientConfig): Promise<ProviderDaemonLeaseResponse> => {
    const response = await requestProviderDaemonJson(endpoint, PROVIDER_DAEMON_LEASES_PATH, {
      method: "POST",
      timeoutMs: 3_000,
      signal: AbortSignal.timeout(3_000),
      maxResponseBytes: 8_192,
      body: JSON.stringify({
        clientKind: role === "provider-daemon" ? "desktop-main" : "provider-daemon",
        capabilities: ["health", "events", "rpc", "lease"],
      }),
    });
    if (response.statusCode !== 200) return fail("lease-unavailable");
    return decodeLease(JSON.parse(response.body));
  };
}

interface RecordSnapshot {
  readonly marker: ProviderDaemonMarker;
  readonly revision: string;
  readonly credentialBase64?: string;
}

const fence = (record: RecordSnapshot) => record.marker.windowsOwnershipId ?? record.revision;

/** Private control flow, never surfaced as a provider/startup diagnostic. */
class StopSupervisorBeforeMutation extends Error {
  readonly revision: string;
  readonly ownershipId: string;
  readonly identity: WindowsProcessIdentity;
  constructor(revision: string, ownershipId: string, identity: WindowsProcessIdentity) {
    super("Independent supervisor ownership must be stopped first.");
    this.revision = revision;
    this.ownershipId = ownershipId;
    this.identity = identity;
  }
}

/** Private continuation: long startup waits never retain a native guard helper. */
class AwaitFreshChildOutsideGuard extends Error {
  health: ProviderDaemonHealth | undefined;
  readonly record: RecordSnapshot;
  readonly child: WindowsRuntimeChild;
  readonly progress: WindowsRuntimeStartupProgress;
  constructor(
    record: RecordSnapshot,
    child: WindowsRuntimeChild,
    progress: WindowsRuntimeStartupProgress,
  ) {
    super("Await the exact fresh child after releasing its ownership guard.");
    this.record = record;
    this.child = child;
    this.progress = progress;
  }
}

/**
 * Windows-only lifecycle policy shared by the desktop daemon and explicit
 * supervisor manager. Each helper session both owns the OS guard and performs
 * the conditional file mutations. This process never writes ownership files.
 */
export function createWindowsProviderRuntime(
  options: WindowsProviderRuntimeOptions,
): WindowsProviderRuntime {
  const open = options.openSession ?? openWindowsOwnershipSession;
  const healthRequest = options.fetchHealth ?? readHealth;
  const leaseRequest = options.issueLease ?? defaultLease(options.role);
  const now = options.now ?? Date.now;
  const monotonicNow = options.monotonicNow ?? options.now ?? performance.now.bind(performance);
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const readinessTimeoutMs = Math.min(Math.max(options.readinessTimeoutMs ?? 30_000, 1), 45_000);
  let active: { readonly result: WindowsProviderRuntimeResult; readonly revision: string } | null =
    null;
  let tail = Promise.resolve();
  let supervisorStopPermit: StopSupervisorBeforeMutation | undefined;

  // One controller cannot overlap stop/adopt/recover. The helper's OS guard is
  // still required because another Electron/backend process has its own queue.
  const serialize = <A>(operation: () => Promise<A>): Promise<A> => {
    const result = tail.then(operation, operation);
    tail = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  const sessionOperation = async <A>(
    operation: (session: WindowsOwnershipSession) => Promise<A>,
  ) => {
    let freshAdmission: AwaitFreshChildOutsideGuard | undefined;
    let freshAccepted = false;
    try {
      // At most one cross-role handoff per operation. Each marker revision is
      // rechecked after the other role completes; no pair of ownership guards
      // is held concurrently, and newer publications abort the old decision.
      // One independent supervisor handoff plus one fresh-child continuation
      // requires at most three guarded transactions; no retry renews startup.
      for (let transaction = 0; transaction < 3; transaction += 1) {
        let session: WindowsOwnershipSession;
        try {
          session = await open({
            markerPath: options.markerPath,
            legacyCredentialPath: options.legacyCredentialPath,
            role: options.role,
          });
        } catch (error) {
          return fail("ownership-unavailable", error);
        }
        let requestedStop: StopSupervisorBeforeMutation | undefined;
        let requestedWait: AwaitFreshChildOutsideGuard | undefined;
        let released = false;
        try {
          if (supervisorStopPermit) {
            const latest = await session.read();
            if (latest.revision !== supervisorStopPermit.revision) return fail("ownership-changed");
          }
          if (freshAdmission) {
            const result = await resumeFreshAdmission(session, freshAdmission);
            freshAccepted = true;
            // Only fresh ensure/recover can produce this private continuation;
            // observation and stop never enter its result-bearing branch.
            return result as A;
          }
          return await operation(session);
        } catch (error) {
          if (error instanceof StopSupervisorBeforeMutation) requestedStop = error;
          else if (error instanceof AwaitFreshChildOutsideGuard) requestedWait = error;
          else if (error instanceof WindowsProviderRuntimeError) throw error;
          else return fail("ownership-unavailable", error);
        } finally {
          // close() confirms helper exit/guard release. If that observation is
          // uncertain we must not acquire the other role's guard concurrently.
          try {
            await session.close();
            released = true;
          } catch {
            /* Preserve original failure. */
          }
        }
        if (requestedWait) {
          freshAdmission = requestedWait;
          if (!released) return fail("ownership-unavailable");
          // The handoff permit described the retired owner, not this newly
          // published generation. Re-admission instead fences its exact record.
          supervisorStopPermit = undefined;
          // This is pure endpoint/direct-child observation outside the OS
          // guard. A timeout keeps the prepared reservation and child intact.
          freshAdmission.health = await waitForFreshAdmission(freshAdmission);
          continue;
        }
        if (!released || !requestedStop || !options.stopSupervisor || supervisorStopPermit) {
          return fail("upstream-ownership-unknown");
        }
        try {
          await options.stopSupervisor({
            ownershipId: requestedStop.ownershipId,
            identity: requestedStop.identity,
          });
        } catch {
          return fail("upstream-ownership-unknown");
        }
        supervisorStopPermit = requestedStop;
      }
      return fail("upstream-ownership-unknown");
    } finally {
      supervisorStopPermit = undefined;
      freshAdmission?.progress.tracker.finish(freshAccepted ? "ready" : "failed");
      freshAdmission?.child.closeStartupProgress?.();
    }
  };
  const recordFrom = (snapshot: WindowsOwnershipSnapshot): RecordSnapshot | null => {
    if (snapshot.markerJson === null && snapshot.revision === null) return null;
    if (snapshot.markerJson === null || snapshot.revision === null) return fail("invalid-record");
    let marker: ProviderDaemonMarker;
    try {
      marker = decodeMarker(JSON.parse(snapshot.markerJson));
    } catch {
      return fail("invalid-record");
    }
    const transport = marker.transport ?? "tcp";
    let validEndpoint = false;
    if (transport === "ipc") {
      // This controller only owns its configured, role-specific named pipe.
      // Treat arbitrary endpoint substitutions as uncertainty, not authority to
      // send a private token to another listener or erase its recovery records.
      validEndpoint = marker.socketPath === options.socketPath;
    } else {
      try {
        const url = new URL(marker.httpBaseUrl);
        validEndpoint =
          url.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
          url.username === "" &&
          url.password === "";
      } catch {
        /* Invalid addresses preserve the exact existing record. */
      }
    }
    if (
      (marker.mode ?? "provider-daemon") !== options.role ||
      !validEndpoint ||
      (marker.windowsProcessIdentity && marker.windowsProcessIdentity.pid !== marker.pid)
    ) {
      return fail("invalid-record");
    }
    return {
      marker,
      revision: snapshot.revision,
      ...(snapshot.credentialBase64 === undefined
        ? {}
        : { credentialBase64: snapshot.credentialBase64 }),
    };
  };
  const read = async (session: WindowsOwnershipSession) => recordFrom(await session.read());
  const checkExpected = (record: RecordSnapshot | null, expected: string | undefined) => {
    if (expected !== undefined && (record === null || fence(record) !== expected)) {
      return fail("ownership-changed");
    }
  };
  const rootEndpoint = async (record: RecordSnapshot): Promise<ProviderDaemonClientConfig> => {
    let token: string;
    try {
      if (record.credentialBase64 === undefined) {
        // Very old token-in-marker records remain decodable, but are never
        // copied to diagnostics or persisted into newly generated records.
        if (record.marker.token === undefined) return fail("credential-unavailable");
        token = record.marker.token;
      } else {
        token = await options.decodeCredential(
          record.credentialBase64,
          record.marker.credentialEncrypted ?? options.role === "provider-daemon",
        );
      }
      if (token.length < 32) return fail("credential-unavailable");
    } catch {
      return fail("credential-unavailable");
    }
    return {
      httpBaseUrl: record.marker.httpBaseUrl,
      transport: record.marker.transport ?? "tcp",
      ...(record.marker.socketPath === undefined ? {} : { socketPath: record.marker.socketPath }),
      token,
    };
  };
  const observeHealth = async (endpoint: ProviderDaemonClientConfig) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return decodeHealth(await healthRequest(endpoint));
      } catch {
        if (attempt === 0) await sleep(150);
      }
    }
    return fail("endpoint-unavailable");
  };
  const authMatches = (record: RecordSnapshot, health: ProviderDaemonHealth) => {
    const marker = record.marker;
    return (
      health.mode === options.role &&
      health.pid === marker.pid &&
      (marker.windowsOwnershipId === undefined ||
        (health.windowsOwnershipId === marker.windowsOwnershipId &&
          health.windowsProcessIdentity !== undefined)) &&
      (marker.windowsProcessIdentity === undefined ||
        health.windowsProcessIdentity === undefined ||
        sameIdentity(marker.windowsProcessIdentity, health.windowsProcessIdentity))
    );
  };
  const compatible = (marker: ProviderDaemonMarker, health: ProviderDaemonHealth) =>
    marker.appVersion === options.appVersion &&
    health.version === options.appVersion &&
    marker.protocolVersion === options.protocolVersion &&
    health.protocolVersion === options.protocolVersion &&
    marker.runtimeBuildId === options.runtimeBuildId &&
    health.runtimeBuildId === options.runtimeBuildId &&
    (options.cafeMcpPort?.() === undefined || marker.cafeMcpPort === options.cafeMcpPort?.());
  const publish = async (
    session: WindowsOwnershipSession,
    record: RecordSnapshot | null,
    marker: ProviderDaemonMarker,
    credentialBase64?: string,
  ): Promise<RecordSnapshot> => {
    try {
      const revision = await session.publish({
        expectedRevision: record?.revision ?? null,
        markerJson: JSON.stringify(marker),
        ...(credentialBase64 === undefined ? {} : { credentialBase64 }),
      });
      return {
        marker,
        revision,
        ...(credentialBase64 === undefined
          ? record?.credentialBase64 === undefined
            ? {}
            : { credentialBase64: record.credentialBase64 }
          : { credentialBase64 }),
      };
    } catch (error) {
      // The mutation may already have committed. Do not retry, remove or spawn;
      // the next ensure opens a new guard and re-observes the durable record.
      return fail("mutation-uncertain", error);
    }
  };
  const retire = async (session: WindowsOwnershipSession, record: RecordSnapshot) => {
    try {
      await session.retire(record.revision);
    } catch (error) {
      return fail("mutation-uncertain", error);
    }
    if (active && active.result.ownershipId === fence(record)) active = null;
  };
  const staleConflictCheck = async (record: RecordSnapshot) => {
    let endpoint: ProviderDaemonClientConfig;
    try {
      endpoint = await rootEndpoint(record);
    } catch {
      return;
    }
    let health: ProviderDaemonHealth;
    try {
      health = await observeHealth(endpoint);
    } catch {
      return;
    }
    // A successfully authenticated responder contradicts a dead/reused owner.
    // Even a response echoing the old marker must not be dismissed: the helper
    // and endpoint disagree, so no file or process mutation is authorized.
    if (health.ok) return fail("endpoint-conflict");
  };
  const terminate = async (session: WindowsOwnershipSession, record: RecordSnapshot) => {
    const identity = record.marker.windowsProcessIdentity;
    if (!identity) return fail("identity-unknown");
    const outcome = await session.terminate(identity);
    if (outcome.status === "unknown") return fail("termination-uncertain");
    if (outcome.status === "different-process") await staleConflictCheck(record);
    await retire(session, record);
  };
  const requireNoUnboundUpstream = (record: RecordSnapshot, health: ProviderDaemonHealth) => {
    // A daemon's authenticated health does not grant authority over a separate
    // supervisor PID. Automatic supervisor handoff remains disabled. If an
    // explicitly configured legacy topology is still present, preserve it
    // rather than silently leaving it alive or killing a potentially new owner.
    if (
      options.role === "provider-daemon" &&
      (health.upstreamSupervisor?.configured || health.supervisorProcess !== undefined)
    ) {
      const upstream = health.upstreamSupervisor;
      const ownershipId = upstream?.windowsOwnershipId;
      const identity = upstream?.windowsProcessIdentity;
      if (supervisorStopPermit?.revision === record.revision) {
        // The independent stop was confirmed. Its disappearance is expected,
        // not an instruction to retry that stop. A newly reported generation,
        // birth identity or PID is contradictory and preserves the daemon.
        if (
          (ownershipId !== undefined && ownershipId !== supervisorStopPermit.ownershipId) ||
          (identity !== undefined && !sameIdentity(identity, supervisorStopPermit.identity)) ||
          (upstream?.pid !== undefined && upstream.pid !== supervisorStopPermit.identity.pid)
        ) {
          return fail("endpoint-conflict");
        }
        if (upstream === undefined || !upstream.reachable) return;
      }
      if (
        !options.stopSupervisor ||
        !ownershipId ||
        !identity ||
        identity.pid !== upstream?.pid ||
        upstream.mode !== "provider-supervisor"
      )
        return fail("upstream-ownership-unknown");
      if (
        supervisorStopPermit?.revision === record.revision &&
        supervisorStopPermit.ownershipId === ownershipId &&
        sameIdentity(supervisorStopPermit.identity, identity)
      )
        return;
      throw new StopSupervisorBeforeMutation(record.revision, ownershipId, identity);
    }
  };
  const leaseAndAccept = async (
    session: WindowsOwnershipSession,
    record: RecordSnapshot,
    endpoint: ProviderDaemonClientConfig,
    health: ProviderDaemonHealth,
    adopted: boolean,
  ) => {
    let lease: ProviderDaemonLeaseResponse;
    try {
      lease = decodeLease(await leaseRequest(endpoint));
    } catch {
      return fail("lease-unavailable");
    }
    const identity = record.marker.windowsProcessIdentity;
    if (!identity || (await session.observe(identity)).status !== "same-process")
      return fail("identity-unknown");
    const current = await read(session);
    if (!current || current.revision !== record.revision) return fail("ownership-changed");
    const result: WindowsProviderRuntimeResult = {
      marker: record.marker,
      health,
      rootEndpoint: endpoint,
      endpoint: { ...endpoint, token: lease.token, leaseId: lease.leaseId },
      adopted,
      ownershipId: fence(record),
    };
    active = { result, revision: record.revision };
    return result;
  };

  const admit = async (
    session: WindowsOwnershipSession,
    initial: RecordSnapshot,
    child?: WindowsRuntimeChild,
    allowReplacement = true,
    observedHealth?: ProviderDaemonHealth,
  ): Promise<WindowsProviderRuntimeResult | null> => {
    let record = initial;
    const marker = record.marker;
    const prepared = marker.windowsOwnershipState === "prepared";
    const expectedIdentity = marker.windowsProcessIdentity;
    const before = expectedIdentity
      ? await session.observe(expectedIdentity)
      : marker.pid > 0
        ? await session.capture(marker.pid)
        : { status: "unknown" as const };
    if (before.status === "exited" || before.status === "different-process") {
      if (!allowReplacement) return fail("ownership-changed");
      await staleConflictCheck(record);
      await retire(session, record);
      return null;
    }
    if (before.status === "unknown" && !prepared)
      return fail(expectedIdentity ? "identity-unknown" : "legacy-identity-unknown");
    const endpoint = await rootEndpoint(record);
    let health: ProviderDaemonHealth;
    try {
      health = observedHealth ?? (await observeHealth(endpoint));
    } catch {
      return fail(
        prepared
          ? "prepared-attempt-uncertain"
          : expectedIdentity
            ? "endpoint-unavailable"
            : "legacy-identity-unknown",
      );
    }
    if (prepared) {
      // Generation authentication is the binding to the bootstrap attempt. A
      // post-spawn PID observation alone cannot authorize admission or killing.
      const identity = health.windowsProcessIdentity;
      if (expectedIdentity && identity && !sameIdentity(expectedIdentity, identity)) {
        return fail("endpoint-conflict");
      }
      if (
        !marker.windowsOwnershipId ||
        health.windowsOwnershipId !== marker.windowsOwnershipId ||
        health.mode !== options.role ||
        !identity ||
        identity.pid !== health.pid ||
        (marker.pid !== 0 && health.pid !== marker.pid) ||
        (child && (child.hasExited() || child.pid !== health.pid)) ||
        (await session.observe(identity)).status !== "same-process"
      )
        return fail("child-admission-uncertain");
      record = await publish(session, record, {
        ...marker,
        pid: identity.pid,
        windowsProcessIdentity: identity,
        windowsOwnershipState: "committed",
        updatedAt: new Date(now()).toISOString(),
      });
    } else {
      if (!authMatches(record, health)) return fail("endpoint-conflict");
      if (expectedIdentity) {
        if ((await session.observe(expectedIdentity)).status !== "same-process")
          return fail("identity-unknown");
      } else {
        // Authenticated legacy owners cannot echo a generation never sent to
        // their bootstrap. Upgrade identity only, retain their credential, and
        // use the exact marker revision as the opaque mutation fence.
        if (
          before.status !== "present" ||
          before.identity.pid !== health.pid ||
          (await session.observe(before.identity)).status !== "same-process"
        )
          return fail("legacy-identity-unknown");
        record = await publish(session, record, {
          ...marker,
          windowsProcessIdentity: before.identity,
          updatedAt: new Date(now()).toISOString(),
        });
      }
    }
    if (!compatible(record.marker, health)) {
      if (!allowReplacement) return fail("ownership-changed");
      requireNoUnboundUpstream(record, health);
      await terminate(session, record);
      return null;
    }
    return leaseAndAccept(session, record, endpoint, health, child === undefined);
  };

  const waitForFreshAdmission = async (attempt: AwaitFreshChildOutsideGuard) => {
    const endpoint = await rootEndpoint(attempt.record);
    do {
      if (attempt.child.hasExited()) return undefined;
      if (attempt.progress.elapsedMs() >= attempt.progress.tracker.deadlineMs) break;
      try {
        const health = decodeHealth(await healthRequest(endpoint));
        if (attempt.progress.elapsedMs() < attempt.progress.tracker.deadlineMs) return health;
      } catch {
        // Readiness transport failures grant no process/file authority. Only
        // exact-child validated migration frames can adjust the finite budget.
      }
      const remaining = attempt.progress.tracker.deadlineMs - attempt.progress.elapsedMs();
      if (remaining <= 0) break;
      await sleep(Math.min(200, remaining));
    } while (attempt.progress.elapsedMs() < attempt.progress.tracker.deadlineMs);
    return fail("prepared-attempt-uncertain");
  };
  const resumeFreshAdmission = async (
    session: WindowsOwnershipSession,
    attempt: AwaitFreshChildOutsideGuard,
  ) => {
    const current = await read(session);
    if (
      !current ||
      current.revision !== attempt.record.revision ||
      fence(current) !== fence(attempt.record) ||
      current.marker.pid !== attempt.child.pid ||
      current.marker.windowsOwnershipState !== "prepared"
    )
      return fail("ownership-changed");
    if (attempt.child.hasExited()) {
      await staleConflictCheck(current);
      await retire(session, current);
      return fail("child-admission-uncertain");
    }
    if (attempt.progress.elapsedMs() >= attempt.progress.tracker.deadlineMs)
      return fail("prepared-attempt-uncertain");
    // The ordinary admission path authenticates generation and FILETIME,
    // re-observes native identity, then publishes/leases under this fresh guard.
    const result = await admit(session, current, attempt.child, true, attempt.health);
    return result ?? fail("child-admission-uncertain");
  };

  const spawnFresh = async (
    session: WindowsOwnershipSession,
  ): Promise<WindowsProviderRuntimeResult> => {
    // The live helper/guard plus an actual native identity query are the
    // preflight. Unknown means policy/runtime support is unavailable: no spawn.
    if ((await session.capture(process.pid)).status !== "present")
      return fail("ownership-unavailable");
    const ownershipId = randomUUID();
    const token = randomBytes(32).toString("hex");
    let credential: { readonly base64: string; readonly encrypted: boolean };
    try {
      credential = await options.encodeCredential(token);
    } catch {
      return fail("credential-unavailable");
    }
    const timestamp = new Date(now()).toISOString();
    const cafeMcpPort = options.cafeMcpPort?.();
    const marker: ProviderDaemonMarker = {
      version: 2,
      mode: options.role,
      pid: 0,
      ppid: process.pid,
      protocolVersion: options.protocolVersion,
      transport: "ipc",
      httpBaseUrl: "http://provider-daemon.local",
      socketPath: options.socketPath,
      credentialPath: windowsOwnershipCredentialPath(options.legacyCredentialPath, ownershipId),
      credentialEncrypted: credential.encrypted,
      createdAt: timestamp,
      updatedAt: timestamp,
      appVersion: options.appVersion,
      ...(options.runtimeBuildId === undefined ? {} : { runtimeBuildId: options.runtimeBuildId }),
      windowsOwnershipId: ownershipId,
      windowsOwnershipState: "prepared",
      ...(cafeMcpPort === undefined ? {} : { cafeMcpPort }),
    };
    // Prepared pid=0 is a durable reservation, NOT a dead process. A crash or
    // lost response from this publication cannot justify a second child.
    let record = await publish(session, null, marker, credential.base64);
    const spawnedAtMs = monotonicNow();
    const progress: WindowsRuntimeStartupProgress = {
      tracker: makeProviderDaemonStartupProgressTracker(readinessTimeoutMs, (record) => {
        try {
          if (options.role === "provider-daemon") options.onStartupProgress?.(record);
        } catch {
          // UI observation cannot change native ownership or expose its cause.
        }
      }),
      elapsedMs: () => Math.max(0, monotonicNow() - spawnedAtMs),
    };
    progress.tracker.start();
    let child: WindowsRuntimeChild | undefined;
    let handedOff = false;
    try {
      child = await options.spawn(
        {
          ...options.bootstrap,
          mode: options.role,
          transport: "ipc",
          socketPath: options.socketPath,
          token,
          ...(options.runtimeBuildId === undefined
            ? {}
            : { runtimeBuildId: options.runtimeBuildId }),
          windowsOwnershipId: ownershipId,
          ...(options.role === "provider-daemon"
            ? { startupProgressFd: BACKEND_STARTUP_PROGRESS_FD }
            : {}),
          ...(cafeMcpPort === undefined ? {} : { cafeMcpPort }),
        },
        // Only this role's exact newly owned daemon gets the migration grant.
        // Supervisors retain ordinary readiness even when sharing this policy.
        options.role === "provider-daemon" ? progress : undefined,
      );
      if (!Number.isInteger(child.pid) || child.pid <= 0 || child.pid > 0xffff_ffff)
        return fail("child-admission-uncertain");
      record = await publish(session, record, { ...record.marker, pid: child.pid });
      handedOff = true;
      throw new AwaitFreshChildOutsideGuard(record, child, progress);
    } catch (error) {
      if (
        error instanceof AwaitFreshChildOutsideGuard ||
        error instanceof WindowsProviderRuntimeError
      )
        throw error;
      return fail("child-admission-uncertain");
    } finally {
      if (!handedOff) {
        progress.tracker.finish("failed");
        child?.closeStartupProgress?.();
      }
    }
  };
  const ensureInSession = async (session: WindowsOwnershipSession) => {
    const record = await read(session);
    if (record) {
      const result = await admit(session, record);
      if (result) return result;
    }
    return spawnFresh(session);
  };
  const stopInSession = async (
    session: WindowsOwnershipSession,
    expected?: string,
    expectedIdentity?: WindowsProcessIdentity,
  ) => {
    let record = await read(session);
    if (!record && expected !== undefined && expectedIdentity !== undefined) {
      // A prior retirement may have committed before its reply was lost. The
      // independently authenticated caller retains that exact generation/birth
      // identity, so re-observe it rather than blindly replaying the mutation.
      // An absent record alone proves nothing about the process. Only confirmed
      // exit/reuse plus a second guarded absence permits this no-op success;
      // there is deliberately no termination, file removal or spawn here.
      const observed = await session.observe(expectedIdentity);
      if (observed.status !== "exited" && observed.status !== "different-process") {
        return fail("identity-unknown");
      }
      if (await read(session)) return fail("ownership-changed");
      if (active?.result.ownershipId === expected) active = null;
      return;
    }
    checkExpected(record, expected);
    if (!record) {
      active = null;
      return;
    }
    if (
      expectedIdentity &&
      (!record.marker.windowsProcessIdentity ||
        !sameIdentity(expectedIdentity, record.marker.windowsProcessIdentity))
    )
      return fail("ownership-changed");
    const identity = record.marker.windowsProcessIdentity;
    if (identity) {
      const observed = await session.observe(identity);
      if (observed.status === "exited" || observed.status === "different-process") {
        await staleConflictCheck(record);
        await retire(session, record);
        return;
      }
      if (observed.status === "unknown") return fail("identity-unknown");
    }
    // A previously authenticated cached binding authorizes stopping that exact
    // record even when its event loop is no longer responding. Other records
    // must authenticate now before the native same-handle action is allowed.
    if (!active || active.revision !== record.revision) {
      const adopted = await admit(session, record);
      if (!adopted) return;
      record = await read(session);
      if (!record || !active || active.revision !== record.revision)
        return fail("ownership-changed");
    }
    let terminationHealth = active.result.health;
    if (supervisorStopPermit) {
      // The other role could have changed while this role's guard was released.
      // A cached pre-handoff supervisor summary cannot authorize the second
      // half of the transaction; require a fresh authenticated daemon response.
      terminationHealth = await observeHealth(active.result.rootEndpoint);
      if (!authMatches(record, terminationHealth)) return fail("endpoint-conflict");
    }
    requireNoUnboundUpstream(record, terminationHealth);
    await terminate(session, record);
  };
  return {
    ensure: () => serialize(() => sessionOperation(ensureInSession)),
    current: () => active?.result ?? null,
    observe: () =>
      serialize(async () => {
        const expected = active?.result.ownershipId;
        if (!active) return { status: "unknown" as const };
        try {
          return await sessionOperation(async (session) => {
            const record = await read(session);
            checkExpected(record, expected);
            if (!record?.marker.windowsProcessIdentity || active?.revision !== record.revision) {
              return {
                status: "unknown" as const,
                ...(expected === undefined ? {} : { ownershipId: expected }),
              };
            }
            const outcome = await session.observe(record.marker.windowsProcessIdentity);
            return {
              status: outcome.status,
              ...(expected === undefined ? {} : { ownershipId: expected }),
            };
          });
        } catch {
          return {
            status: "unknown" as const,
            ...(expected === undefined ? {} : { ownershipId: expected }),
          };
        }
      }),
    stop: (expected, expectedIdentity) =>
      serialize(() =>
        sessionOperation((session) => stopInSession(session, expected, expectedIdentity)),
      ),
    recover: (expected) =>
      serialize(() =>
        sessionOperation(async (session) => {
          const record = await read(session);
          if (
            expected !== undefined &&
            record &&
            fence(record) !== expected &&
            active &&
            active.revision === record.revision
          ) {
            // Another serialized ensure already accepted the new generation after
            // the watchdog took its snapshot. Revalidate that binding without any
            // replacement authority and return its lease so the stopped backend
            // can reconnect; stale snapshots never kill or overwrite the new owner.
            const current = await admit(session, record, undefined, false);
            if (current) return current;
            return fail("ownership-changed");
          }
          await stopInSession(session, expected);
          return ensureInSession(session);
        }),
      ),
  };
}
