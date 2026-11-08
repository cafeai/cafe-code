import type { MacKeepAwakeState } from "@cafecode/contracts";
import {
  DESKTOP_POWER_STATE_LEASE_MS,
  type DesktopPowerState,
} from "@cafecode/shared/desktopPowerState";

export interface MacPowerLease {
  renew(): void;
  /** Retires input synchronously; resolves only after this native child's close. */
  close(): Promise<void>;
}
export interface MacBackendPowerOwner {
  observe(state: DesktopPowerState): void;
  retire(): void;
}
interface Owner {
  retired: boolean;
  sequence: number;
  received: number;
  wallReceived: number;
  enabled: boolean;
  workActive: boolean;
}
interface Attempt {
  readonly owner: Owner;
  retired: boolean;
}
export interface MacKeepAwakeControllerOptions {
  readonly supported: boolean;
  readonly start: (input: {
    readonly current: () => boolean;
    readonly state: (state: MacKeepAwakeState) => void;
    readonly exited: () => void;
  }) => Promise<MacPowerLease | null>;
  readonly now?: () => number;
  readonly wallNow?: () => number;
}

/** One exact backend incarnation, one native attempt, no renderer lifetime.
 * Intent is never refreshed by a cached UI value, replay, late native result,
 * or old backend. A healthy 16-hour job renews short leases; there is no job
 * deadline and no provider/retry/approval behavior in this controller. */
export class MacKeepAwakeController {
  private owner: Owner | null = null;
  private attempt: Attempt | null = null;
  private lease: MacPowerLease | null = null;
  private faulted = false;
  private failure: MacKeepAwakeState | null = null;
  private disposed = false;
  private intentRevoked = false;
  private driving: Promise<void> | null = null;
  private again = false;
  private state: MacKeepAwakeState = { phase: "off", reason: null };
  private readonly clock: () => number;
  private readonly wall: () => number;
  private readonly options: MacKeepAwakeControllerOptions;
  constructor(options: MacKeepAwakeControllerOptions) {
    this.options = options;
    this.clock = options.now ?? (() => performance.now());
    this.wall = options.wallNow ?? Date.now;
  }
  snapshot(): MacKeepAwakeState {
    return this.state;
  }
  setIntent(enabled: boolean): void {
    if (this.disposed) return;
    this.intentRevoked = !enabled;
    if (!enabled) this.retireAttempt();
    else {
      this.faulted = false;
      this.failure = null;
    }
    this.pump();
  }
  bindBackend(): MacBackendPowerOwner {
    if (this.owner) this.retire(this.owner);
    const owner: Owner = {
      retired: false,
      sequence: -1,
      received: -Infinity,
      wallReceived: -Infinity,
      enabled: false,
      workActive: false,
    };
    this.owner = owner;
    if (this.failure?.reason !== "cleanup-failed") {
      this.faulted = false;
      this.failure = null;
    }
    this.pump();
    return {
      observe: (frame) => {
        if (
          this.disposed ||
          owner.retired ||
          this.owner !== owner ||
          frame.sequence <= owner.sequence
        )
          return;
        const wasWanted = owner.enabled && owner.workActive;
        owner.sequence = frame.sequence;
        owner.received = this.clock();
        owner.wallReceived = this.wall();
        owner.enabled = frame.enabled;
        owner.workActive = frame.workActive;
        if (
          !frame.enabled ||
          ((!wasWanted || !frame.workActive) && this.failure?.reason !== "cleanup-failed")
        ) {
          this.faulted = false;
          this.failure = null;
        }
        this.pump();
      },
      retire: () => this.retire(owner),
    };
  }
  private retire(owner: Owner): void {
    owner.retired = true;
    if (this.owner !== owner) return;
    this.owner = null;
    this.retireAttempt();
    this.pump();
  }
  private fresh(owner: Owner): boolean {
    const age = this.clock() - owner.received;
    const wallAge = this.wall() - owner.wallReceived;
    return (
      !this.disposed &&
      this.owner === owner &&
      !owner.retired &&
      Number.isFinite(age) &&
      age >= 0 &&
      age < DESKTOP_POWER_STATE_LEASE_MS &&
      Number.isFinite(wallAge) &&
      wallAge >= 0 &&
      wallAge < DESKTOP_POWER_STATE_LEASE_MS
    );
  }
  private wanted(owner: Owner): boolean {
    return (
      !this.intentRevoked &&
      this.options.supported &&
      this.fresh(owner) &&
      owner.enabled &&
      owner.workActive &&
      !this.faulted
    );
  }
  private retireAttempt(): void {
    if (this.attempt) this.attempt.retired = true;
    // Calling close ends the private stdin immediately, before any await.
    if (this.lease) void this.lease.close().catch(() => {});
  }
  /** Called by the scoped desktop timer. Only fresh exact-backend state renews. */
  tick(): void {
    const owner = this.owner;
    if (owner && this.wanted(owner) && this.lease && !this.attempt?.retired) this.lease.renew();
    else if (!owner || !this.wanted(owner)) this.retireAttempt();
    this.pump();
  }
  private pump(): void {
    this.again = true;
    if (this.driving) return;
    this.driving = this.drive()
      .catch(() => {
        // A failed close retains the exact native reservation; never admit a
        // competing child or crash Cafe because optional power cleanup failed.
        this.faulted = true;
        this.again = false;
        this.failure = this.state = { phase: "unavailable", reason: "cleanup-failed" };
      })
      .finally(() => {
        this.driving = null;
        if (this.again) this.pump();
      });
  }
  private async drive(): Promise<void> {
    while (this.again) {
      this.again = false;
      const owner = this.owner;
      if (
        this.lease &&
        (this.attempt?.retired || !owner || this.attempt?.owner !== owner || !this.wanted(owner))
      ) {
        const closing = this.lease;
        this.state = { phase: "stopping", reason: null };
        await closing.close();
        if (this.lease === closing) {
          this.lease = null;
          this.attempt = null;
        }
        this.again = true;
        continue;
      }
      if (this.intentRevoked || !owner || !this.fresh(owner) || !owner.enabled) {
        this.state = {
          phase: "off",
          reason: !this.intentRevoked && owner?.enabled ? "backend-unavailable" : null,
        };
        continue;
      }
      if (!owner.workActive) {
        this.state = { phase: "idle", reason: null };
        continue;
      }
      if (!this.options.supported) {
        this.state = { phase: "unavailable", reason: "native-unavailable" };
        continue;
      }
      if (this.faulted) {
        this.state = this.failure ?? { phase: "unavailable", reason: "native-unavailable" };
        continue;
      }
      if (this.lease) continue;
      const attempt: Attempt = { owner, retired: false };
      this.attempt = attempt;
      const current = () => this.attempt === attempt && !attempt.retired && this.wanted(owner);
      this.state = { phase: "starting", reason: null };
      try {
        const lease = await this.options.start({
          current,
          state: (state) => {
            if (!current()) return;
            this.state = state;
            if (state.phase === "unavailable") {
              this.faulted = true;
              this.failure = state;
              attempt.retired = true;
              this.pump();
            }
          },
          exited: () => {
            if (this.attempt !== attempt || attempt.retired) return;
            this.faulted = true;
            this.failure = this.state =
              this.state.reason === "cleanup-failed"
                ? this.state
                : { phase: "unavailable", reason: "native-unavailable" };
            attempt.retired = true;
            this.pump();
          },
        });
        if (!current()) {
          if (lease) await lease.close();
          if (this.attempt === attempt) this.attempt = null;
          this.again = true;
          continue;
        }
        if (!lease) {
          this.faulted = true;
          if (this.state.phase === "starting")
            this.state = { phase: "unavailable", reason: "native-unavailable" };
          this.failure = this.state;
          continue;
        }
        this.lease = lease;
        lease.renew();
      } catch {
        if (this.attempt === attempt && !attempt.retired && this.fresh(owner)) {
          this.faulted = true;
          if (this.state.phase === "starting")
            this.state = { phase: "unavailable", reason: "native-unavailable" };
          this.failure = this.state;
        }
        if (this.attempt === attempt) this.attempt = null;
      }
    }
  }
  async settled(): Promise<void> {
    while (this.driving) await this.driving;
  }
  async close(): Promise<void> {
    this.disposed = true;
    if (this.owner) this.retire(this.owner);
    this.retireAttempt();
    this.pump();
    await this.settled();
  }
}
