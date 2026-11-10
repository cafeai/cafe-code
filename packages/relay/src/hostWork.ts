import * as Schema from "effect/Schema";
import { concatenate, unopaque, utf8 } from "./bytes.ts";
import { sha256, type RelayIdentity } from "./crypto.ts";
import { canonicalBytes, Id16, Id32, SafeCounter } from "./protocol.ts";
import type { NetworkDescriptor, RelayNode } from "./descriptor.ts";
import type { Lifetime } from "./lifetime.ts";
import { requireRelay } from "./errors.ts";

/** Work buys one host slot. It grants no viewer/application authority. */
export const HOST_WORK = Object.freeze({
  difficulty: 20,
  maximumDifficulty: 24,
  challengeMs: 30_000,
  reservationMs: 600_000,
  renewBeforeMs: 120_000,
  receiptMs: 60_000,
  receipts: 256,
  claims: 4,
  jobs: 8,
  solveMs: 4_000,
  automaticWorkIntervalMs: 60_000,
  trials: 67_108_864,
});
export const HostWorkRequest = Schema.Struct({
  version: Schema.Literal(1),
  networkId: Id32,
  locator: Id32,
  admissionPublicKey: Id32,
  capacityToken: Id32,
  claimId: Id16,
  reservationId: Schema.Union([Id16, Schema.Null]),
});
export type HostWorkRequest = typeof HostWorkRequest.Type;
export const HostWorkChallenge = Schema.Struct({
  version: Schema.Literal(1),
  purpose: Schema.Literal("host-reservation"),
  networkId: Id32,
  nodeId: Id32,
  bootId: Id16,
  locator: Id32,
  admissionPublicKey: Id32,
  claimId: Id16,
  reservationId: Schema.Union([Id16, Schema.Null]),
  slots: Schema.Literal(1),
  reservationMs: SafeCounter.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(HOST_WORK.reservationMs),
  ),
  difficulty: SafeCounter.check(Schema.isLessThanOrEqualTo(HOST_WORK.maximumDifficulty)),
  issuedAt: SafeCounter,
  expiresAt: SafeCounter,
  nonce: Id32,
  mac: Id32,
});
export type HostWorkChallenge = typeof HostWorkChallenge.Type;
const Counter = SafeCounter.check(Schema.isLessThanOrEqualTo(0xffff_ffff));
export const HostWorkSolutions = Schema.Tuple([Counter, Counter, Counter, Counter]);
export type HostWorkSolutions = typeof HostWorkSolutions.Type;
export const HostWorkClaim = Schema.Struct({
  challenge: HostWorkChallenge,
  solutions: HostWorkSolutions,
  signature: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{86}$/)),
});
export type HostWorkClaim = typeof HostWorkClaim.Type;
export const HostReservationCredential = Schema.Struct({ id: Id16, token: Id32 });
export type HostReservationCredential = typeof HostReservationCredential.Type;
export const HostReservation = Schema.Struct({
  version: Schema.Literal(1),
  networkId: Id32,
  nodeId: Id32,
  bootId: Id16,
  locator: Id32,
  admissionPublicKey: Id32,
  claimId: Id16,
  credential: HostReservationCredential,
  expiresAt: SafeCounter,
  renewAt: SafeCounter,
});
export type HostReservation = typeof HostReservation.Type;
export const HostWorkRelease = Schema.Struct({
  networkId: Id32,
  nodeId: Id32,
  bootId: Id16,
  locator: Id32,
  admissionPublicKey: Id32,
  credential: HostReservationCredential,
  signature: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{86}$/)),
});
export type HostWorkRelease = typeof HostWorkRelease.Type;

export function hostWorkPrefix(challenge: HostWorkChallenge): Uint8Array {
  return sha256(
    concatenate(utf8.encode("CafeCode/relay/host-work/v1\0"), canonicalBytes(challenge)),
  );
}
export function hostWorkDigest(prefix: Uint8Array, part: number, counter: number): Uint8Array {
  requireRelay(prefix.byteLength === 32 && part >= 0 && part < 4);
  const bytes = new Uint8Array(37);
  bytes.set(prefix);
  bytes[32] = part;
  new DataView(bytes.buffer).setUint32(33, counter);
  return sha256(bytes);
}
export function hasWorkBits(digest: Uint8Array, bits: number): boolean {
  requireRelay(digest.byteLength === 32 && Number.isSafeInteger(bits) && bits >= 0 && bits <= 24);
  const full = Math.floor(bits / 8),
    rest = bits % 8;
  for (let index = 0; index < full; index++) if (digest[index] !== 0) return false;
  return rest === 0 || digest[full]! >>> (8 - rest) === 0;
}
export function verifyHostWork(
  challenge: HostWorkChallenge,
  solutions: HostWorkSolutions,
): boolean {
  requireRelay(challenge.difficulty >= 2 && challenge.difficulty <= HOST_WORK.maximumDifficulty);
  const prefix = hostWorkPrefix(challenge);
  // Four domain-separated subpuzzles cost about 2^difficulty trials in total.
  // Every part is checked, including when a previous part failed.
  let valid = 1;
  for (let part = 0; part < 4; part++)
    valid &= Number(
      hasWorkBits(hostWorkDigest(prefix, part, solutions[part]!), challenge.difficulty - 2),
    );
  return valid === 1;
}
export function hostWorkProof(value: unknown, release = false): Uint8Array {
  return concatenate(
    utf8.encode(release ? "CafeCode/relay/host-release/v1\0" : "CafeCode/relay/host-claim/v1\0"),
    canonicalBytes(value),
  );
}
export function validateHostWorkScope(
  value: {
    readonly networkId: string;
    readonly nodeId: string;
    readonly locator: string;
    readonly admissionPublicKey: string;
  },
  scope: HostWorkScope,
): void {
  requireRelay(
    value.networkId === scope.network.networkId &&
      value.nodeId === scope.node.id &&
      value.locator === scope.locator &&
      value.admissionPublicKey === scope.admissionIdentity.publicKey,
    "AUTH_DENIED",
  );
  for (const field of [value.networkId, value.nodeId, value.locator, value.admissionPublicKey])
    unopaque(field, 32);
}
export interface HostWorkScope {
  readonly network: NetworkDescriptor;
  readonly node: RelayNode;
  readonly locator: string;
  readonly capacityToken: string;
  readonly admissionIdentity: RelayIdentity;
  readonly allowLoopbackTest: boolean;
}
export interface HostWorkClient {
  acquire(
    scope: HostWorkScope,
    lifetime: Lifetime,
    previous?: HostReservation,
    renew?: boolean,
  ): Promise<HostReservation>;
  release(scope: HostWorkScope, reservation: HostReservation): Promise<void>;
}
export interface HostReservationAuthority {
  readonly bootId: string;
  authorize(
    locator: string,
    key: string,
    credential: HostReservationCredential | undefined,
  ): HostReservation;
  expiry(locator: string, id: string): number;
  retire(): void;
}
