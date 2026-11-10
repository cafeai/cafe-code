import { deferred } from "./deferred.ts";
import { Budget } from "./budget.ts";
import { RelayError, requireRelay } from "./errors.ts";
import { Lifetime } from "./lifetime.ts";
import { RELAY_LIMITS } from "./limits.ts";
import type * as Clock from "effect/Clock";

export interface WireCallbacks {
  readonly open: () => void;
  readonly message: (bytes: Uint8Array) => void;
  readonly close: () => void;
  readonly error: () => void;
}
/** A driver must retain its native error observer through actual native close. */
export interface WireDriver {
  readonly install: (callbacks: WireCallbacks, lifetime: Lifetime) => void;
  readonly send: (bytes: Uint8Array, flushed: (success: boolean) => void) => void;
  readonly terminate: () => void;
}
export interface RelayResources {
  readonly owners: Budget;
  readonly pending: Budget;
  readonly clock?: Clock.Clock;
}
export const relayResources = (clock?: Clock.Clock): RelayResources => ({
  owners: new Budget(RELAY_LIMITS.owners),
  pending: new Budget(RELAY_LIMITS.aggregatePendingBytes),
  ...(clock ? { clock } : {}),
});

/**
 * An exact native connection owner. A send keeps both reservations until its
 * callback proves flush, or native close proves the buffer is no longer owned.
 * Failure/retirement never frees a still-live native write's capacity early.
 */
export class PacketConnection {
  readonly lifetime: Lifetime;
  readonly opened: Promise<void>;
  readonly closed: Promise<void>;
  private readonly local = new Budget(RELAY_LIMITS.ownerPendingBytes);
  private readonly resources: RelayResources;
  private readonly driver: WireDriver;
  private readonly releaseOwner: () => void;
  private readonly writes = new Set<() => void>();
  private readonly inbox: Array<{ bytes: Uint8Array; release: () => void }> = [];
  private readonly drainListeners = new Set<() => void>();
  private receiver: ((bytes: Uint8Array) => void) | undefined;
  private closeObserver: (() => void) | undefined;
  private readonly resolveOpened: () => void;
  private readonly rejectOpened: (error: RelayError) => void;
  private readonly resolveClosed: () => void;
  private nativeClosed = false;
  private isOpen = false;
  private retirementRequested = false;

  constructor(driver: WireDriver, resources: RelayResources, admittedOwner?: () => void) {
    const owner = admittedOwner ?? resources.owners.reserve();
    requireRelay(owner, "BUSY");
    this.releaseOwner = owner;
    this.driver = driver;
    this.resources = resources;
    this.lifetime = new Lifetime(() => this.retire(), resources.clock);
    const opened = deferred<void>();
    this.opened = opened.promise;
    this.resolveOpened = () => opened.resolve();
    this.rejectOpened = opened.reject;
    // Construction owns rejection even when a caller is still acquiring state.
    void this.opened.catch(() => {});
    const closed = deferred<void>();
    this.closed = closed.promise;
    this.resolveClosed = () => closed.resolve();
    this.lifetime.later(RELAY_LIMITS.handshakeMs, () => {
      if (!this.isOpen) this.retire();
    });
    try {
      driver.install(
        {
          open: () => {
            if (!this.lifetime.active) return;
            this.isOpen = true;
            this.resolveOpened();
          },
          message: (bytes) => {
            if (!this.lifetime.active) return;
            try {
              requireRelay(bytes.byteLength > 0 && bytes.byteLength <= RELAY_LIMITS.outerBytes);
              if (this.receiver) this.receiver(bytes);
              else {
                requireRelay(this.inbox.length < 8, "BUSY");
                const release = this.charge(bytes.byteLength, true);
                requireRelay(release, "BUSY");
                this.inbox.push({ bytes, release });
              }
            } catch {
              this.retire();
            }
          },
          close: () => this.nativeClose(),
          error: () => this.retire(),
        },
        this.lifetime,
      );
    } catch {
      this.retire();
    }
  }

  receive(receiver: (bytes: Uint8Array) => void): void {
    requireRelay(this.lifetime.active && !this.receiver);
    this.receiver = receiver;
    for (const item of this.inbox.splice(0)) {
      item.release();
      if (this.lifetime.active) {
        try {
          receiver(item.bytes);
        } catch {
          this.retire();
        }
      }
    }
  }

  onClosed(observer: () => void): void {
    requireRelay(!this.closeObserver);
    this.closeObserver = observer;
    if (this.nativeClosed) observer();
  }

  onDrain(observer: () => void): () => void {
    requireRelay(this.drainListeners.size < RELAY_LIMITS.owners, "BUSY");
    this.drainListeners.add(observer);
    return () => this.drainListeners.delete(observer);
  }

  private charge(amount: number, control: boolean): (() => void) | undefined {
    if (!control && amount > this.local.available - RELAY_LIMITS.controlReserveBytes)
      return undefined;
    const local = this.local.reserve(amount);
    if (!local) return undefined;
    const global = this.resources.pending.reserve(amount);
    if (!global) {
      local();
      return undefined;
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      local();
      global();
    };
  }

  send(bytes: Uint8Array, control = false): boolean {
    if (!this.lifetime.active || !this.isOpen || bytes.byteLength > RELAY_LIMITS.outerBytes)
      return false;
    const release = this.charge(bytes.byteLength, control);
    if (!release) return false;
    this.writes.add(release);
    try {
      this.driver.send(bytes, (success) => {
        if (!success) {
          this.retire();
          return;
        }
        this.writes.delete(release);
        release();
        if (this.lifetime.active)
          for (const observer of this.drainListeners) {
            try {
              observer();
            } catch {
              this.retire();
              break;
            }
          }
      });
    } catch {
      this.retire();
      return false;
    }
    return true;
  }

  retire(): void {
    if (this.retirementRequested || this.nativeClosed) return;
    this.retirementRequested = true;
    this.lifetime.retire();
    this.receiver = undefined;
    this.rejectOpened(new RelayError("UNAVAILABLE"));
    for (const item of this.inbox.splice(0)) item.release();
    try {
      this.driver.terminate();
    } catch {
      /* Native close remains the release boundary. */
    }
  }

  private nativeClose(): void {
    if (this.nativeClosed) return;
    this.nativeClosed = true;
    this.lifetime.retire();
    this.receiver = undefined;
    this.rejectOpened(new RelayError("UNAVAILABLE"));
    for (const item of this.inbox.splice(0)) item.release();
    for (const release of this.writes) release();
    this.writes.clear();
    this.drainListeners.clear();
    this.releaseOwner();
    try {
      this.closeObserver?.();
    } finally {
      this.resolveClosed();
    }
  }

  async close(): Promise<void> {
    this.retire();
    await this.closed;
    await this.lifetime.close();
  }
  get active(): boolean {
    return this.lifetime.active;
  }
  get pendingBytes(): number {
    return this.local.current;
  }
}
