import { requireRelay } from "./errors.ts";
import { RELAY_LIMITS } from "./limits.ts";

/**
 * Synchronous admission precedes asynchronous IO. The returned exact owner is
 * idempotent, so cancellation/close races cannot free a replacement's capacity.
 */
export class Budget {
  private used = 0;
  readonly maximum: number;

  constructor(maximum: number) {
    requireRelay(Number.isSafeInteger(maximum) && maximum > 0);
    this.maximum = maximum;
  }

  reserve(amount = 1): (() => void) | undefined {
    requireRelay(Number.isSafeInteger(amount) && amount > 0);
    if (amount > this.maximum - this.used) return undefined;
    this.used += amount;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.used -= amount;
    };
  }

  get current(): number {
    return this.used;
  }
  get available(): number {
    return this.maximum - this.used;
  }
}

export class TokenBucket {
  private tokens: number;
  private observedAt: number;
  readonly capacity: number;
  readonly perMillisecond: number;

  constructor(capacity: number, perSecond: number, now: number) {
    requireRelay(Number.isFinite(now) && Number.isFinite(perSecond) && perSecond > 0);
    requireRelay(Number.isSafeInteger(capacity) && capacity > 0);
    this.capacity = capacity;
    this.perMillisecond = perSecond / 1_000;
    this.tokens = capacity;
    this.observedAt = now;
  }

  take(now: number, count = 1): boolean {
    requireRelay(Number.isFinite(now) && Number.isFinite(count) && count > 0);
    // A backward clock cannot refill or postpone the existing observation.
    const current = Math.max(now, this.observedAt);
    this.tokens = Math.min(
      this.capacity,
      this.tokens + (current - this.observedAt) * this.perMillisecond,
    );
    this.observedAt = current;
    if (count > this.tokens) return false;
    this.tokens -= count;
    return true;
  }
  retryAfter(now: number, count = 1): number {
    const current = Math.max(now, this.observedAt);
    const available = Math.min(
      this.capacity,
      this.tokens + (current - this.observedAt) * this.perMillisecond,
    );
    return Math.max(1, Math.ceil((count - available) / this.perMillisecond));
  }
}

/** IP/prefix tracking is bounded and never an application-identity authority. */
export class AdmissionLimiter {
  private readonly global: TokenBucket;
  private readonly prefixes = new Map<string, { bucket: TokenBucket; seen: number }>();
  private readonly phase: "anonymous" | "native";

  constructor(now: number, phase: "anonymous" | "native" = "anonymous") {
    this.global = new TokenBucket(32, 16, now);
    this.phase = phase;
  }

  admit(prefix: string, now: number): boolean {
    requireRelay(prefix.length > 0 && prefix.length <= 64);
    if (!this.global.take(now)) return false;
    for (const [key, value] of this.prefixes) {
      if (now - value.seen >= RELAY_LIMITS.ipIdleMs) this.prefixes.delete(key);
    }
    let entry = this.prefixes.get(prefix);
    if (!entry) {
      if (this.prefixes.size >= RELAY_LIMITS.ipEntries) return false;
      entry = {
        bucket:
          this.phase === "native" ? new TokenBucket(16, 4, now) : new TokenBucket(4, 12 / 60, now),
        seen: now,
      };
      this.prefixes.set(prefix, entry);
    }
    const admitted = entry.bucket.take(now);
    if (admitted) entry.seen = now;
    return admitted;
  }

  get trackedPrefixes(): number {
    return this.prefixes.size;
  }
}

/** Absolute cumulative credits make retransmitted WINDOW messages idempotent. */
export class CreditWindow {
  private sent = 0;
  private ceiling = 0;
  readonly maximumWindow: number;

  constructor(maximumWindow: number) {
    requireRelay(Number.isSafeInteger(maximumWindow) && maximumWindow > 0);
    this.maximumWindow = maximumWindow;
  }

  update(ceiling: number): void {
    requireRelay(Number.isSafeInteger(ceiling) && ceiling >= this.ceiling);
    requireRelay(ceiling >= this.sent && ceiling - this.sent <= this.maximumWindow);
    this.ceiling = ceiling;
  }

  take(amount: number): boolean {
    requireRelay(Number.isSafeInteger(amount) && amount > 0);
    if (amount > this.ceiling - this.sent) return false;
    this.sent += amount;
    requireRelay(Number.isSafeInteger(this.sent));
    return true;
  }

  get available(): number {
    return this.ceiling - this.sent;
  }
  get transmitted(): number {
    return this.sent;
  }
}
