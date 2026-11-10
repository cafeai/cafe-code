import * as Schema from "effect/Schema";
import { Id16, Id32, SafeCounter } from "./protocol.ts";
import { HostReservationCredential } from "./hostWork.ts";

export const Signature = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{86}$/));
export const Hello = Schema.Struct({
  version: Schema.Literal(1),
  networkId: Id32,
  nodeId: Id32,
  bootId: Id16,
  challenge: Id32,
  expiresAt: SafeCounter,
});
export type Hello = typeof Hello.Type;
export const Priority = Schema.Literals([0, 1]);
export const Register = Schema.Struct({
  locator: Id32,
  admissionPublicKey: Id32,
  capacityToken: Id32,
  priority: Priority,
  reservation: Schema.optionalKey(HostReservationCredential),
  signature: Signature,
});
export type Register = typeof Register.Type;
export const Registered = Schema.Struct({ registrationId: Id16, expiresAt: SafeCounter });
export type Registered = typeof Registered.Type;
export const Lease = Schema.Struct({ registrationId: Id16, priority: Priority });
export const Attach = Schema.Struct({
  locator: Id32,
  registrationId: Id16,
  viewerCircuitNonce: Id16,
  admissionPublicKey: Id32,
  ticket: Schema.Union([Id32, Schema.Null]),
  recovery: Schema.Boolean,
  signature: Signature,
});
export type Attach = typeof Attach.Type;
export const Offer = Schema.Struct({
  locator: Id32,
  registrationId: Id16,
  viewerCircuitNonce: Id16,
  admissionPublicKey: Id32,
  recovery: Schema.Boolean,
});
export type Offer = typeof Offer.Type;
export const Accept = Schema.Struct({ registrationId: Id16 });
export const Window = Schema.Struct({ ceiling: SafeCounter });
export const MintTickets = Schema.Struct({
  requestId: Id16,
  registrationId: Id16,
  purpose: Schema.Literals(["invite", "resume"]),
  admissionPublicKey: Schema.Union([Id32, Schema.Null]),
  count: SafeCounter,
});
export type MintTickets = typeof MintTickets.Type;
export const Tickets = Schema.Struct({
  requestId: Id16,
  tickets: Schema.Array(Schema.Struct({ token: Id32, expiresAt: SafeCounter })).check(
    Schema.isMaxLength(4),
  ),
});
export const EmptyControl = Schema.Struct({});
export const FixedError = Schema.Struct({
  code: Schema.Literals(["UNAVAILABLE", "BUSY", "PROTOCOL_ERROR", "EXPIRED", "AUTH_DENIED"]),
});
export const Lookup = Schema.Struct({ networkId: Id32, locator: Id32 });
export const DirectoryRecord = Schema.Struct({
  locator: Id32,
  registrationId: Id16,
  expiresAt: SafeCounter,
  priority: Priority,
});
export type DirectoryRecord = typeof DirectoryRecord.Type;
export const DirectorySnapshot = Schema.Struct({
  networkId: Id32,
  nodeId: Id32,
  bootId: Id16,
  sequence: SafeCounter,
  records: Schema.Array(DirectoryRecord).check(Schema.isMaxLength(32)),
});
export type DirectorySnapshot = typeof DirectorySnapshot.Type;
export const LookupResult = Schema.Struct({
  networkId: Id32,
  candidates: Schema.Array(
    Schema.Struct({ nodeId: Id32, registrationId: Id16, priority: Priority }),
  ).check(Schema.isMaxLength(3)),
});
export type LookupResult = typeof LookupResult.Type;
