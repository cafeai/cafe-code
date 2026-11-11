import { Budget, CreditWindow, TokenBucket } from "./budget.ts";
import { equalBytes, randomOpaque, unopaque, utf8, concatenate } from "./bytes.ts";
import * as C from "./controls.ts";
import { sha256, verifyBytes } from "./crypto.ts";
import type { NetworkDescriptor } from "./descriptor.ts";
import { RelayDirectory } from "./directory.ts";
import { requireRelay } from "./errors.ts";
import { epochNow, Lifetime } from "./lifetime.ts";
import { RELAY_LIMITS } from "./limits.ts";
import {
  OUTER,
  ZERO_CIRCUIT,
  canonicalBytes,
  decodeOuter,
  encodeOuter,
  readCanonical,
  type OuterFrame,
  type OuterOpcode,
} from "./protocol.ts";
import { TicketStore } from "./tickets.ts";
import type { PacketConnection, RelayResources } from "./wire.ts";
import type { HostReservationAuthority } from "./hostWork.ts";
import { authorizeHostEnrollment } from "./admission.ts";

export interface HostCapacityGrant {
  readonly locator: string;
  readonly admissionPublicKey: string;
  readonly tokenDigest: string;
}
interface Leg {
  readonly connection: PacketConnection;
  readonly hello: C.Hello;
  readonly controls: TokenBucket;
  readonly data: TokenBucket;
  readonly circuits: Set<Circuit>;
  readonly cancelAnonymous: () => void;
  challenged: boolean;
  pending: boolean;
  host: Registration | undefined;
  viewer: Circuit | undefined;
}
interface Registration {
  readonly leg: Leg;
  readonly locator: string;
  readonly admissionPublicKey: string;
  readonly id: string;
  readonly reservationId: string;
  expiresAt: number;
  priority: 0 | 1;
}
interface Direction {
  readonly credit: CreditWindow;
}
interface Circuit {
  readonly id: string;
  readonly host: Registration;
  readonly viewer: Leg;
  readonly lifetime: Lifetime;
  readonly release: () => void;
  readonly releasePreauth: () => void;
  readonly fromHost: Direction;
  readonly fromViewer: Direction;
  accepted: boolean;
  authorized: boolean;
  expiresAt: number;
  cancelAuth: () => void;
  active: boolean;
}

const proofDomain = utf8.encode("CafeCode/relay/admission/v1\0");
export function admissionProof(hello: C.Hello, request: unknown): Uint8Array {
  return concatenate(proofDomain, canonicalBytes({ hello, request }));
}

/** Single-hop ciphertext switch. Native socket owners are supplied by the listener. */
export class RelayBroker {
  network: NetworkDescriptor;
  readonly nodeId: string;
  readonly bootId: string;
  readonly directory: RelayDirectory;
  private readonly resources: RelayResources;
  private readonly grants: readonly HostCapacityGrant[];
  private readonly selfService: boolean;
  private readonly reservations: HostReservationAuthority;
  private readonly now: () => number;
  private readonly lifetime = new Lifetime(() => this.retire());
  private readonly legs = new Set<Leg>();
  private readonly registrations = new Map<string, Registration>();
  private readonly registering = new Map<string, object>();
  private readonly circuits = new Map<string, Circuit>();
  private readonly tickets = new TicketStore();
  private readonly anonymous = new Budget(RELAY_LIMITS.anonymousCircuits);
  private readonly recovery = new Budget(RELAY_LIMITS.recoveryCircuits);
  private readonly recoveringLocators = new Set<string>();
  private readonly globalControls: TokenBucket;
  private readonly globalData: TokenBucket;
  private readonly publishOwn: ReturnType<RelayDirectory["begin"]>;
  private sequence = 0;

  constructor(input: {
    readonly network: NetworkDescriptor;
    readonly nodeId: string;
    readonly grants: readonly HostCapacityGrant[];
    readonly selfService?: boolean;
    readonly reservations: HostReservationAuthority;
    readonly resources: RelayResources;
    readonly now?: () => number;
    readonly directory?: RelayDirectory;
  }) {
    this.network = input.network;
    this.nodeId = input.nodeId;
    requireRelay(
      this.network.nodes.some((node) => node.id === this.nodeId),
      "NETWORK_MISMATCH",
    );
    requireRelay(input.grants.length <= RELAY_LIMITS.registrations);
    this.grants = input.grants;
    this.selfService = input.selfService === true;
    this.reservations = input.reservations;
    this.bootId = input.reservations.bootId;
    this.resources = input.resources;
    this.now = input.now ?? epochNow;
    this.directory = input.directory ?? new RelayDirectory(input.network);
    this.publishOwn = this.directory.begin(this.nodeId);
    this.globalControls = new TokenBucket(512, 256, this.now());
    this.globalData = new TokenBucket(1024, 512, this.now());
    this.publish();
    this.sweep();
  }

  accept(connection: PacketConnection): void {
    if (!this.lifetime.active) {
      connection.retire();
      return;
    }
    const now = this.now();
    const hello: C.Hello = {
      version: 1,
      networkId: this.network.networkId,
      nodeId: this.nodeId,
      bootId: this.bootId,
      challenge: randomOpaque(),
      expiresAt: now + RELAY_LIMITS.challengeMs,
    };
    const leg: Leg = {
      connection,
      hello,
      controls: new TokenBucket(64, 32, now),
      data: new TokenBucket(128, 64, now),
      circuits: new Set(),
      challenged: false,
      pending: false,
      host: undefined,
      viewer: undefined,
      cancelAnonymous: connection.lifetime.later(RELAY_LIMITS.handshakeMs, () => {
        if (!leg.host && !leg.viewer) connection.retire();
      }),
    };
    this.legs.add(leg);
    connection.onClosed(() => this.closed(leg));
    connection.receive((bytes) => {
      try {
        const frame = decodeOuter(bytes);
        const current = this.now();
        requireRelay(
          frame.opcode === OUTER.DATA
            ? leg.data.take(current) && this.globalData.take(current)
            : leg.controls.take(current) && this.globalControls.take(current),
          "BUSY",
        );
        requireRelay(!leg.pending);
        this.dispatch(leg, frame, bytes);
      } catch {
        connection.retire();
      }
    });
    if (!this.send(leg, OUTER.HELLO, ZERO_CIRCUIT, hello)) connection.retire();
  }

  private send(leg: Leg, opcode: OuterOpcode, id: string, payload: unknown): boolean {
    return leg.connection.send(
      encodeOuter(opcode, id, canonicalBytes(payload, RELAY_LIMITS.controlBytes)),
      true,
    );
  }

  private dispatch(leg: Leg, frame: OuterFrame, encoded: Uint8Array): void {
    if (frame.opcode === OUTER.REGISTER) {
      requireRelay(frame.circuitId === ZERO_CIRCUIT && !leg.host && !leg.viewer && !leg.challenged);
      leg.challenged = true;
      leg.pending = true;
      const request = readCanonical(C.Register, frame.payload);
      void this.register(leg, request)
        .catch(() => leg.connection.retire())
        .finally(() => {
          leg.pending = false;
        });
      return;
    }
    if (frame.opcode === OUTER.ATTACH) {
      requireRelay(frame.circuitId === ZERO_CIRCUIT && !leg.host && !leg.viewer && !leg.challenged);
      leg.challenged = true;
      leg.pending = true;
      const request = readCanonical(C.Attach, frame.payload);
      void this.attach(leg, request)
        .catch(() => leg.connection.retire())
        .finally(() => {
          leg.pending = false;
        });
      return;
    }
    if (frame.opcode === OUTER.LEASE) {
      const request = readCanonical(C.Lease, frame.payload);
      const host = leg.host;
      requireRelay(
        host &&
          request.registrationId === host.id &&
          this.registrations.get(host.locator) === host &&
          frame.circuitId === ZERO_CIRCUIT,
      );
      const paidExpiry = this.reservations.expiry(host.locator, host.reservationId);
      requireRelay(paidExpiry > this.now(), "EXPIRED");
      host.expiresAt = Math.min(this.now() + RELAY_LIMITS.leaseMs, paidExpiry);
      host.priority = request.priority;
      this.publish();
      return;
    }
    if (frame.opcode === OUTER.MINT_TICKETS) {
      requireRelay(frame.circuitId === ZERO_CIRCUIT);
      const request = readCanonical(C.MintTickets, frame.payload);
      const host = leg.host;
      requireRelay(host && host.id === request.registrationId && host.expiresAt > this.now());
      requireRelay(request.count >= 1 && request.count <= 4);
      requireRelay((request.purpose === "invite") === (request.admissionPublicKey === null));
      const tickets = [];
      for (let index = 0; index < request.count; index++) {
        const ticket = this.tickets.issue(
          {
            nodeId: this.nodeId,
            bootId: this.bootId,
            registrationId: host.id,
            purpose: request.purpose,
            ...(request.admissionPublicKey
              ? { admissionPublicKey: request.admissionPublicKey }
              : {}),
          },
          this.now(),
        );
        if (ticket) tickets.push(ticket);
      }
      requireRelay(
        this.send(leg, OUTER.TICKETS, ZERO_CIRCUIT, { requestId: request.requestId, tickets }),
        "BUSY",
      );
      return;
    }
    const circuit = this.circuits.get(frame.circuitId);
    requireRelay(circuit?.active && (circuit.host.leg === leg || circuit.viewer === leg));
    requireRelay(circuit.expiresAt > this.now(), "EXPIRED");
    const isHost = circuit.host.leg === leg;
    const other = isHost ? circuit.viewer : circuit.host.leg;
    if (frame.opcode === OUTER.CLOSE) {
      readCanonical(C.EmptyControl, frame.payload);
      this.closeCircuit(circuit);
      return;
    }
    if (frame.opcode === OUTER.ACCEPT) {
      requireRelay(
        isHost &&
          !circuit.accepted &&
          readCanonical(C.Accept, frame.payload).registrationId === circuit.host.id,
      );
      circuit.accepted = true;
      requireRelay(
        this.send(circuit.viewer, OUTER.ACCEPT, circuit.id, { registrationId: circuit.host.id }),
        "BUSY",
      );
      return;
    }
    if (frame.opcode === OUTER.AUTHORIZE) {
      readCanonical(C.EmptyControl, frame.payload);
      requireRelay(isHost && circuit.accepted);
      circuit.authorized = true;
      circuit.cancelAuth();
      circuit.releasePreauth();
      circuit.expiresAt = this.now() + RELAY_LIMITS.leaseMs;
      return;
    }
    requireRelay(circuit.accepted);
    if (frame.opcode === OUTER.WINDOW) {
      const ceiling = readCanonical(C.Window, frame.payload).ceiling;
      (isHost ? circuit.fromViewer : circuit.fromHost).credit.update(ceiling);
      requireRelay(other.connection.send(encoded, true), "BUSY");
      return;
    }
    requireRelay(frame.opcode === OUTER.DATA && frame.payload.byteLength > 0);
    requireRelay((isHost ? circuit.fromHost : circuit.fromViewer).credit.take(encoded.byteLength));
    // A full native leg rejects only this circuit, preserving the host's other
    // circuits and the reserved control allowance. No unbounded forwarding queue.
    if (!other.connection.send(encoded)) this.closeCircuit(circuit);
  }

  private async register(leg: Leg, request: C.Register): Promise<void> {
    const now = this.now();
    requireRelay(leg.hello.expiresAt > now, "EXPIRED");
    authorizeHostEnrollment({
      ...request,
      networkId: this.network.networkId,
      grants: this.grants,
      selfService: this.selfService,
    });
    this.reservations.authorize(request.locator, request.admissionPublicKey, request.reservation);
    requireRelay(!this.registering.has(request.locator), "BUSY");
    const owner = {};
    this.registering.set(request.locator, owner);
    try {
      const { signature, ...unsigned } = request;
      requireRelay(
        await verifyBytes(
          request.admissionPublicKey,
          admissionProof(leg.hello, unsigned),
          signature,
        ),
        "AUTH_DENIED",
      );
      requireRelay(
        this.lifetime.active &&
          leg.connection.active &&
          this.registering.get(request.locator) === owner &&
          leg.hello.expiresAt > this.now(),
        "EXPIRED",
      );
      const previous = this.registrations.get(request.locator);
      const paid = this.reservations.authorize(
        request.locator,
        request.admissionPublicKey,
        request.reservation,
      );
      requireRelay(previous || this.registrations.size < RELAY_LIMITS.registrations, "BUSY");
      const host: Registration = {
        leg,
        locator: request.locator,
        admissionPublicKey: request.admissionPublicKey,
        id: randomOpaque(16),
        reservationId: paid.credential.id,
        priority: request.priority,
        expiresAt: Math.min(this.now() + RELAY_LIMITS.leaseMs, paid.expiresAt),
      };
      this.registrations.set(request.locator, host);
      leg.host = host;
      leg.cancelAnonymous();
      if (previous) previous.leg.connection.retire();
      requireRelay(
        this.send(leg, OUTER.REGISTERED, ZERO_CIRCUIT, {
          registrationId: host.id,
          expiresAt: host.expiresAt,
        }),
        "BUSY",
      );
      this.publish();
    } finally {
      if (this.registering.get(request.locator) === owner) this.registering.delete(request.locator);
    }
  }

  private async attach(leg: Leg, request: C.Attach): Promise<void> {
    const host = this.registrations.get(request.locator);
    requireRelay(
      host && host.id === request.registrationId && host.expiresAt > this.now(),
      "UNAVAILABLE",
    );
    requireRelay(leg.hello.expiresAt > this.now(), "EXPIRED");
    requireRelay(request.recovery === (request.ticket === null));
    const releaseAnonymous = this.anonymous.reserve();
    requireRelay(releaseAnonymous, "BUSY");
    const releaseOwner = this.resources.owners.reserve();
    if (!releaseOwner) {
      releaseAnonymous();
      requireRelay(false, "BUSY");
    }
    let releaseRecovery: (() => void) | undefined;
    let reservation: ReturnType<TicketStore["reserve"]>;
    let committed = false;
    let releaseCircuit = () => {
      releaseAnonymous();
      releaseOwner();
      releaseRecovery?.();
    };
    try {
      if (request.recovery) {
        requireRelay(!this.recoveringLocators.has(request.locator), "BUSY");
        releaseRecovery = this.recovery.reserve();
        requireRelay(releaseRecovery, "BUSY");
        this.recoveringLocators.add(request.locator);
        const release = releaseRecovery;
        let heldRecovery = true;
        releaseRecovery = () => {
          if (!heldRecovery) return;
          heldRecovery = false;
          release();
          this.recoveringLocators.delete(request.locator);
        };
      } else {
        requireRelay(request.ticket);
        const scope = { nodeId: this.nodeId, bootId: this.bootId, registrationId: host.id };
        reservation =
          this.tickets.reserve(
            request.ticket,
            { ...scope, purpose: "resume", admissionPublicKey: request.admissionPublicKey },
            this.now(),
          ) ?? this.tickets.reserve(request.ticket, { ...scope, purpose: "invite" }, this.now());
        requireRelay(reservation, "AUTH_DENIED");
      }
      const { signature, ...unsigned } = request;
      requireRelay(
        await verifyBytes(
          request.admissionPublicKey,
          admissionProof(leg.hello, unsigned),
          signature,
        ),
        "AUTH_DENIED",
      );
      requireRelay(
        this.lifetime.active &&
          leg.connection.active &&
          this.registrations.get(host.locator) === host &&
          host.expiresAt > this.now() &&
          leg.hello.expiresAt > this.now(),
        "EXPIRED",
      );
      if (reservation) requireRelay(reservation.commit(this.now()), "EXPIRED");
      const initialCredit = () => {
        const credit = new CreditWindow(RELAY_LIMITS.channelWindowBytes);
        credit.update(RELAY_LIMITS.channelWindowBytes);
        return { credit };
      };
      const lifetime = new Lifetime();
      const id = randomOpaque(16);
      let released = false;
      const ownedRelease = releaseCircuit;
      releaseCircuit = () => {
        if (released) return;
        released = true;
        ownedRelease();
      };
      const circuit: Circuit = {
        id,
        host,
        viewer: leg,
        lifetime,
        release: releaseCircuit,
        releasePreauth: () => {
          releaseAnonymous();
          releaseRecovery?.();
        },
        fromHost: initialCredit(),
        fromViewer: initialCredit(),
        active: true,
        accepted: false,
        authorized: false,
        expiresAt:
          this.now() + (request.recovery ? RELAY_LIMITS.recoveryMs : RELAY_LIMITS.handshakeMs),
        cancelAuth: () => {},
      };
      circuit.cancelAuth = lifetime.later(
        request.recovery ? RELAY_LIMITS.recoveryMs : RELAY_LIMITS.handshakeMs,
        () => this.closeCircuit(circuit),
      );
      this.circuits.set(id, circuit);
      host.leg.circuits.add(circuit);
      leg.circuits.add(circuit);
      leg.viewer = circuit;
      leg.cancelAnonymous();
      committed = true;
      const offer: C.Offer = {
        locator: host.locator,
        registrationId: host.id,
        viewerCircuitNonce: request.viewerCircuitNonce,
        admissionPublicKey: request.admissionPublicKey,
        recovery: request.recovery,
      };
      if (!this.send(host.leg, OUTER.OFFER, id, offer) || !this.send(leg, OUTER.OFFER, id, offer))
        this.closeCircuit(circuit);
    } finally {
      if (!committed) {
        reservation?.release();
        releaseCircuit();
      }
    }
  }

  private closeCircuit(circuit: Circuit): void {
    if (!circuit.active) return;
    circuit.active = false;
    circuit.lifetime.retire();
    this.circuits.delete(circuit.id);
    circuit.host.leg.circuits.delete(circuit);
    circuit.viewer.circuits.delete(circuit);
    for (const leg of [circuit.host.leg, circuit.viewer])
      if (leg.connection.active) this.send(leg, OUTER.CLOSE, circuit.id, {});
    circuit.release();
    // A viewer socket has exactly one circuit. Its native close owns its writes.
    circuit.viewer.connection.retire();
  }

  private closed(leg: Leg): void {
    this.legs.delete(leg);
    for (const circuit of [...leg.circuits]) this.closeCircuit(circuit);
    const host = leg.host;
    if (host && this.registrations.get(host.locator) === host) {
      this.registrations.delete(host.locator);
      this.tickets.revokeRegistration(host.id);
      this.publish();
    }
  }

  snapshot(): C.DirectorySnapshot {
    return {
      networkId: this.network.networkId,
      nodeId: this.nodeId,
      bootId: this.bootId,
      sequence: this.sequence,
      records: [...this.registrations.values()].map((host) => ({
        locator: host.locator,
        registrationId: host.id,
        expiresAt: host.expiresAt,
        priority: host.priority,
      })),
    };
  }
  updateNetwork(network: NetworkDescriptor): void {
    requireRelay(
      network.nodes.find((node) => node.id === this.nodeId)?.publicKey ===
        this.network.nodes.find((node) => node.id === this.nodeId)?.publicKey,
      "NETWORK_MISMATCH",
    );
    this.directory.update(network);
    this.network = network;
    this.publish();
  }
  private publish(): void {
    this.sequence++;
    requireRelay(Number.isSafeInteger(this.sequence));
    this.publishOwn.publish(this.snapshot(), this.now());
  }
  private sweep(): void {
    if (!this.lifetime.active) return;
    const now = this.now();
    for (const host of this.registrations.values())
      if (
        host.expiresAt <= now ||
        this.reservations.expiry(host.locator, host.reservationId) <= now
      )
        host.leg.connection.retire();
    for (const circuit of this.circuits.values())
      if (circuit.expiresAt <= now) this.closeCircuit(circuit);
    this.tickets.expire(now);
    this.lifetime.later(1_000, () => this.sweep());
  }
  retire(): void {
    this.lifetime.retire();
    this.reservations.retire();
    for (const leg of this.legs) leg.connection.retire();
    this.publishOwn.retire();
  }
  async close(): Promise<void> {
    const held = [...this.legs];
    this.retire();
    await Promise.all(held.map((leg) => leg.connection.close()));
    await this.lifetime.close();
  }
  stats(): {
    readonly connections: number;
    readonly registrations: number;
    readonly circuits: number;
    readonly anonymous: number;
    readonly recovery: number;
    readonly tickets: number;
  } {
    return {
      connections: this.legs.size,
      registrations: this.registrations.size,
      circuits: this.circuits.size,
      anonymous: this.anonymous.current,
      recovery: this.recovery.current,
      tickets: this.tickets.size,
    };
  }
}
