// @effect-diagnostics nodeBuiltinImport:off
// The native relay owns one volatile per-boot HMAC key. No persistent/root key,
// application secret, raw request or identity is logged by reservation admission.
import { createHmac, timingSafeEqual } from "node:crypto";
import { opaque, randomOpaque, unopaque, utf8 } from "@cafecode/relay/bytes";
import { sha256, verifyBytes } from "@cafecode/relay/crypto";
import { canonicalBytes } from "@cafecode/relay/protocol";
import { requireRelay } from "@cafecode/relay/errors";
import { RELAY_LIMITS } from "@cafecode/relay/limits";
import type { HostCapacityGrant } from "@cafecode/relay/broker";
import { authorizeHostEnrollment, authorizeHostIdentity } from "@cafecode/relay/admission";
import {
  HOST_WORK,
  hostWorkProof,
  verifyHostWork,
  type HostWorkRequest,
  type HostWorkChallenge,
  type HostWorkClaim,
  type HostReservation,
  type HostReservationCredential,
  type HostWorkRelease,
  type HostReservationAuthority,
} from "@cafecode/relay/hostWork";

interface ReservationOptions {
  readonly networkId: string;
  readonly nodeId: string;
  readonly grants: readonly HostCapacityGrant[];
  readonly now: () => number;
  readonly difficulty?: number;
  readonly selfService?: boolean;
  readonly reservationMs?: number;
}
export class HostReservations implements HostReservationAuthority {
  readonly bootId = randomOpaque(16);
  private readonly secret = unopaque(randomOpaque(), 32);
  private readonly reservations = new Map<string, HostReservation>();
  private readonly receipts = new Map<
    string,
    { digest: string; result: HostReservation; expiresAt: number }
  >();
  private active = true;
  private checking = 0;
  private currentDifficulty: number;
  private changedAt: number;
  private readonly input: ReservationOptions;
  constructor(input: ReservationOptions) {
    this.input = input;
    this.currentDifficulty = this.difficulty;
    this.changedAt = input.now() - 30_000;
    requireRelay(input.grants.length <= RELAY_LIMITS.registrations);
    requireRelay(
      Number.isSafeInteger(this.difficulty) &&
        this.difficulty >= 2 &&
        this.difficulty <= HOST_WORK.maximumDifficulty,
    );
    requireRelay(
      Number.isSafeInteger(this.duration) &&
        this.duration >= 1 &&
        this.duration <= HOST_WORK.reservationMs,
    );
  }
  private get difficulty() {
    return this.input.difficulty ?? HOST_WORK.difficulty;
  }
  private get duration() {
    return this.input.reservationMs ?? HOST_WORK.reservationMs;
  }
  private nextDifficulty(): number {
    const slots = this.reservations.size,
      base = this.difficulty;
    let target = this.currentDifficulty;
    if (target >= base + 2 && slots <= 24) target = base + 1;
    else if (target === base + 1) {
      if (slots >= 28) target = base + 2;
      else if (slots <= 20) target = base;
    } else if (target === base && slots >= 24) target = base + (slots >= 28 ? 2 : 1);
    target = Math.min(target, HOST_WORK.maximumDifficulty);
    const now = this.input.now();
    if (target !== this.currentDifficulty && now - this.changedAt >= 30_000) {
      this.currentDifficulty = target;
      this.changedAt = now;
    }
    return this.currentDifficulty;
  }
  private mac(value: unknown, purpose = "challenge"): string {
    return createHmac("sha256", this.secret)
      .update(utf8.encode("CafeCode/relay/host-work/" + purpose + "/v1\0"))
      .update(canonicalBytes(value))
      .digest("base64url");
  }
  private grant(locator: string, key: string) {
    requireRelay(this.active, "AUTH_DENIED");
    return authorizeHostIdentity({
      networkId: this.input.networkId,
      locator,
      admissionPublicKey: key,
      grants: this.input.grants,
      selfService: this.input.selfService === true,
    });
  }
  private sweep() {
    const now = this.input.now();
    for (const [locator, value] of this.reservations)
      if (value.expiresAt <= now) this.reservations.delete(locator);
    for (const [id, value] of this.receipts) if (value.expiresAt <= now) this.receipts.delete(id);
  }
  challenge(request: HostWorkRequest): HostWorkChallenge {
    this.grant(request.locator, request.admissionPublicKey);
    requireRelay(request.networkId === this.input.networkId, "NETWORK_MISMATCH");
    authorizeHostEnrollment({
      ...request,
      grants: this.input.grants,
      selfService: this.input.selfService === true,
    });
    this.sweep();
    const current = this.reservations.get(request.locator);
    requireRelay(
      request.reservationId
        ? current?.credential.id === request.reservationId
        : !current || current.admissionPublicKey === request.admissionPublicKey,
      "BUSY",
    );
    requireRelay(current || this.reservations.size < RELAY_LIMITS.registrations, "BUSY");
    const issuedAt = this.input.now();
    const unsigned = {
      version: 1 as const,
      purpose: "host-reservation" as const,
      networkId: this.input.networkId,
      nodeId: this.input.nodeId,
      bootId: this.bootId,
      locator: request.locator,
      admissionPublicKey: request.admissionPublicKey,
      claimId: request.claimId,
      reservationId: current?.credential.id ?? null,
      replace: !request.reservationId && !!current,
      slots: 1 as const,
      reservationMs: this.duration,
      difficulty: this.nextDifficulty(),
      issuedAt,
      expiresAt: issuedAt + HOST_WORK.challengeMs,
      nonce: randomOpaque(),
    };
    return { ...unsigned, mac: this.mac(unsigned) };
  }
  async claim(request: HostWorkClaim): Promise<HostReservation> {
    requireRelay(this.active && this.checking < HOST_WORK.claims, "BUSY");
    const challenge = request.challenge;
    this.grant(challenge.locator, challenge.admissionPublicKey);
    const { mac, ...unsignedChallenge } = challenge;
    requireRelay(
      challenge.networkId === this.input.networkId &&
        challenge.nodeId === this.input.nodeId &&
        challenge.bootId === this.bootId,
      "AUTH_DENIED",
    );
    requireRelay(
      timingSafeEqual(unopaque(mac, 32), unopaque(this.mac(unsignedChallenge), 32)),
      "AUTH_DENIED",
    );
    requireRelay(
      challenge.difficulty >= this.difficulty &&
        challenge.difficulty <= Math.min(this.difficulty + 2, HOST_WORK.maximumDifficulty) &&
        challenge.reservationMs === this.duration &&
        challenge.issuedAt <= this.input.now() &&
        challenge.expiresAt === challenge.issuedAt + HOST_WORK.challengeMs,
      "EXPIRED",
    );
    this.sweep();
    const digest = opaque(sha256(canonicalBytes(request))),
      prior = this.receipts.get(challenge.claimId);
    if (prior) {
      requireRelay(
        prior.digest === digest &&
          this.reservations.get(challenge.locator)?.credential.id === prior.result.credential.id,
        "AUTH_DENIED",
      );
      return prior.result;
    }
    requireRelay(challenge.expiresAt > this.input.now(), "EXPIRED");
    requireRelay(verifyHostWork(challenge, request.solutions), "AUTH_DENIED");
    this.checking++;
    try {
      const { signature, ...proof } = request;
      requireRelay(
        await verifyBytes(challenge.admissionPublicKey, hostWorkProof(proof), signature),
        "AUTH_DENIED",
      );
      requireRelay(this.active && challenge.expiresAt > this.input.now(), "EXPIRED");
      this.sweep();
      // A competing verifier may have committed this exact claim while signature
      // verification awaited. Reconcile its fixed result before allocating.
      const committed = this.receipts.get(challenge.claimId);
      if (committed) {
        requireRelay(
          committed.digest === digest &&
            this.reservations.get(challenge.locator)?.credential.id ===
              committed.result.credential.id,
          "AUTH_DENIED",
        );
        return committed.result;
      }
      requireRelay(this.receipts.size < HOST_WORK.receipts, "BUSY");
      const current = this.reservations.get(challenge.locator);
      requireRelay(
        challenge.reservationId ? current?.credential.id === challenge.reservationId : !current,
        "BUSY",
      );
      requireRelay(current || this.reservations.size < RELAY_LIMITS.registrations, "BUSY");
      const credential =
        !challenge.replace && current
          ? current.credential
          : { id: randomOpaque(16), token: randomOpaque() };
      const result: HostReservation = {
        version: 1,
        networkId: this.input.networkId,
        nodeId: this.input.nodeId,
        bootId: this.bootId,
        locator: challenge.locator,
        admissionPublicKey: challenge.admissionPublicKey,
        claimId: challenge.claimId,
        credential,
        expiresAt: Math.max(current?.expiresAt ?? 0, challenge.issuedAt + this.duration),
        renewAt:
          Math.max(current?.expiresAt ?? 0, challenge.issuedAt + this.duration) -
          Math.min(HOST_WORK.renewBeforeMs, Math.max(1, Math.floor(this.duration / 3))),
      };
      requireRelay(result.expiresAt > this.input.now(), "EXPIRED");
      this.reservations.set(challenge.locator, result);
      this.receipts.set(challenge.claimId, {
        digest,
        result,
        expiresAt: challenge.expiresAt + HOST_WORK.receiptMs,
      });
      return result;
    } finally {
      this.checking--;
    }
  }
  authorize(
    locator: string,
    key: string,
    credential: HostReservationCredential | undefined,
  ): HostReservation {
    this.grant(locator, key);
    const current = this.reservations.get(locator);
    requireRelay(
      credential &&
        current &&
        current.expiresAt > this.input.now() &&
        current.admissionPublicKey === key &&
        current.credential.id === credential.id,
      "AUTH_DENIED",
    );
    requireRelay(
      timingSafeEqual(unopaque(current.credential.token, 32), unopaque(credential.token, 32)),
      "AUTH_DENIED",
    );
    return current;
  }
  expiry(locator: string, id: string): number {
    const value = this.reservations.get(locator);
    return this.active && value?.credential.id === id ? value.expiresAt : 0;
  }
  async release(request: HostWorkRelease): Promise<void> {
    requireRelay(this.active && this.checking < HOST_WORK.claims, "BUSY");
    this.grant(request.locator, request.admissionPublicKey);
    requireRelay(
      request.networkId === this.input.networkId &&
        request.nodeId === this.input.nodeId &&
        request.bootId === this.bootId,
      "AUTH_DENIED",
    );
    this.checking++;
    try {
      const { signature, ...proof } = request;
      requireRelay(
        await verifyBytes(request.admissionPublicKey, hostWorkProof(proof, true), signature),
        "AUTH_DENIED",
      );
      requireRelay(this.active, "UNAVAILABLE");
      const current = this.reservations.get(request.locator);
      if (!current || current.credential.id !== request.credential.id) return;
      this.authorize(request.locator, request.admissionPublicKey, request.credential);
      this.reservations.delete(request.locator);
    } finally {
      this.checking--;
    }
  }
  retire(): void {
    this.active = false;
    this.reservations.clear();
    this.receipts.clear();
    this.secret.fill(0);
  }
  stats() {
    this.sweep();
    return {
      reservations: this.reservations.size,
      receipts: this.receipts.size,
      checking: this.checking,
    };
  }
}
