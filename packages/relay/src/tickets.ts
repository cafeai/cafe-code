import { opaque, randomOpaque, unopaque } from "./bytes.ts";
import { sha256 } from "./crypto.ts";
import { requireRelay } from "./errors.ts";
import { RELAY_LIMITS } from "./limits.ts";

export interface TicketScope {
  readonly nodeId: string;
  readonly bootId: string;
  readonly registrationId: string;
  readonly purpose: "invite" | "resume";
  readonly admissionPublicKey?: string;
}
interface StoredTicket {
  readonly scope: TicketScope;
  readonly expiresAt: number;
  reservation: object | undefined;
}

export class TicketStore {
  private readonly entries = new Map<string, StoredTicket>();

  issue(
    scope: TicketScope,
    now: number,
  ): { readonly token: string; readonly expiresAt: number } | undefined {
    requireRelay(Number.isSafeInteger(now) && now >= 0);
    this.expire(now);
    if (this.entries.size >= RELAY_LIMITS.tickets) return undefined;
    let registrationCount = 0;
    for (const value of this.entries.values())
      if (value.scope.registrationId === scope.registrationId) registrationCount++;
    if (registrationCount >= RELAY_LIMITS.ticketsPerRegistration) return undefined;
    const token = randomOpaque();
    const expiresAt = now + RELAY_LIMITS.ticketMs;
    const digest = opaque(sha256(unopaque(token, 32)));
    this.entries.set(digest, {
      scope: Object.freeze({ ...scope }),
      expiresAt,
      reservation: undefined,
    });
    return { token, expiresAt };
  }

  /**
   * Proof verification may await. Reserve this exact observation first, and
   * recheck its incarnation/expiry before committing one-use consumption.
   */
  reserve(
    token: string,
    scope: TicketScope,
    now: number,
  ):
    | {
        readonly commit: (currentTime: number) => boolean;
        readonly release: () => void;
      }
    | undefined {
    const digest = opaque(sha256(unopaque(token, 32)));
    const value = this.entries.get(digest);
    if (!value || value.expiresAt <= now) {
      if (value) this.entries.delete(digest);
      return undefined;
    }
    const held = value.scope;
    if (
      value.reservation ||
      held.nodeId !== scope.nodeId ||
      held.bootId !== scope.bootId ||
      held.registrationId !== scope.registrationId ||
      held.purpose !== scope.purpose ||
      held.admissionPublicKey !== scope.admissionPublicKey
    )
      return undefined;
    const owner = {};
    value.reservation = owner;
    let active = true;
    return {
      commit: (currentTime) => {
        if (!active) return false;
        active = false;
        if (this.entries.get(digest) !== value || value.reservation !== owner) return false;
        this.entries.delete(digest);
        return Number.isFinite(currentTime) && currentTime < value.expiresAt;
      },
      release: () => {
        if (!active) return;
        active = false;
        if (this.entries.get(digest) === value && value.reservation === owner)
          value.reservation = undefined;
      },
    };
  }

  revokeRegistration(registrationId: string): void {
    for (const [key, value] of this.entries)
      if (value.scope.registrationId === registrationId) this.entries.delete(key);
  }

  expire(now: number): void {
    for (const [key, value] of this.entries) if (value.expiresAt <= now) this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }
}
