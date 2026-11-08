import { deferred } from "./deferred.ts";
import type { AbortOptions, MessageStream } from "@libp2p/interface";
import { admissionProof } from "./broker.ts";
import { Budget, CreditWindow, TokenBucket } from "./budget.ts";
import { randomOpaque } from "./bytes.ts";
import * as C from "./controls.ts";
import { signBytes, secureChannel, type RelayIdentity } from "./crypto.ts";
import { RelayError, requireRelay } from "./errors.ts";
import { epochNow } from "./lifetime.ts";
import { RELAY_LIMITS } from "./limits.ts";
import { RelayNoiseStream } from "./noiseStream.ts";
import {
  OUTER,
  ZERO_CIRCUIT,
  canonicalBytes,
  decodeOuter,
  encodeOuter,
  readCanonical,
  type OuterOpcode,
} from "./protocol.ts";
import type { PacketConnection, RelayResources } from "./wire.ts";

export class RelayLeg {
  readonly connection: PacketConnection;
  readonly hello: Promise<C.Hello>;
  readonly registered: Promise<C.Registered>;
  private readonly resolveHello: (value: C.Hello) => void;
  private readonly resolveRegistered: (value: C.Registered) => void;
  private readonly circuits = new Map<string, EndpointCircuit>();
  private readonly tickets = new Map<
    string,
    {
      resolve: (value: typeof C.Tickets.Type) => void;
      reject: (error: RelayError) => void;
      cancel: () => void;
    }
  >();
  private readonly resources: RelayResources;
  private readonly networkId: string;
  private readonly nodeId: string;
  private receivedHello = false;
  private receivedRegistration = false;
  private offerHandler: ((id: string, offer: C.Offer) => void) | undefined;
  private readonly failHello: (error: RelayError) => void;
  private readonly failRegistered: (error: RelayError) => void;
  private readonly controlRate = new TokenBucket(32, 30, epochNow());
  private readonly dataRate = new TokenBucket(64, 60, epochNow());
  private readonly receivedHostDataRate = new TokenBucket(1024, 512, epochNow());
  private readonly receivedHostControlRate = new TokenBucket(512, 256, epochNow());
  private readonly receivedDataRate = new TokenBucket(128, 64, epochNow());
  private readonly receivedControlRate = new TokenBucket(64, 32, epochNow());
  private readonly controlPending = new Budget(RELAY_LIMITS.controlReserveBytes);
  private readonly controls: Array<{
    readonly opcode: OuterOpcode;
    readonly id: string;
    bytes: Uint8Array;
    release: () => void;
  }> = [];
  private scheduledDrain = false;
  private circuitCursor = 0;
  private priority: 0 | 1 = 0;
  private registration: C.Registered | undefined;

  constructor(
    connection: PacketConnection,
    resources: RelayResources,
    networkId: string,
    nodeId: string,
  ) {
    this.connection = connection;
    this.resources = resources;
    this.networkId = networkId;
    this.nodeId = nodeId;
    const hello = deferred<C.Hello>(),
      registered = deferred<C.Registered>();
    this.hello = hello.promise;
    this.registered = registered.promise;
    this.resolveHello = hello.resolve;
    this.failHello = hello.reject;
    this.resolveRegistered = registered.resolve;
    this.failRegistered = registered.reject;
    void this.hello.catch(() => {});
    void this.registered.catch(() => {});
    const retire = () => {
      const error = new RelayError("UNAVAILABLE");
      this.failHello(error);
      this.failRegistered(error);
      for (const circuit of [...this.circuits.values()]) circuit.retire(false);
      for (const request of this.tickets.values()) {
        request.cancel();
        request.reject(error);
      }
      this.tickets.clear();
      for (const entry of this.controls.splice(0)) entry.release();
    };
    connection.onClosed(retire);
    connection.lifetime.signal.addEventListener("abort", retire, { once: true });
    connection.lifetime.later(RELAY_LIMITS.handshakeMs, () => {
      if (!this.receivedHello) connection.retire();
    });
    connection.onDrain(() => this.drain());
    connection.receive((bytes) => {
      const frame = decodeOuter(bytes);
      requireRelay(
        (frame.opcode === OUTER.DATA
          ? this.registration
            ? this.receivedHostDataRate
            : this.receivedDataRate
          : this.registration
            ? this.receivedHostControlRate
            : this.receivedControlRate
        ).take(epochNow()),
        "BUSY",
      );
      if (frame.opcode === OUTER.HELLO) {
        requireRelay(!this.receivedHello && frame.circuitId === ZERO_CIRCUIT);
        const value = readCanonical(C.Hello, frame.payload);
        requireRelay(
          value.networkId === networkId &&
            value.nodeId === nodeId &&
            value.expiresAt > epochNow() &&
            value.expiresAt <= epochNow() + RELAY_LIMITS.challengeMs + RELAY_LIMITS.clockSkewMs,
          "NETWORK_MISMATCH",
        );
        this.receivedHello = true;
        this.resolveHello(value);
        return;
      }
      requireRelay(this.receivedHello);
      if (frame.opcode === OUTER.REGISTERED) {
        requireRelay(!this.receivedRegistration && frame.circuitId === ZERO_CIRCUIT);
        this.receivedRegistration = true;
        this.registration = readCanonical(C.Registered, frame.payload);
        this.resolveRegistered(this.registration);
        return;
      }
      if (frame.opcode === OUTER.TICKETS) {
        requireRelay(frame.circuitId === ZERO_CIRCUIT);
        const value = readCanonical(C.Tickets, frame.payload),
          request = this.tickets.get(value.requestId);
        if (!request) return;
        this.tickets.delete(value.requestId);
        request.cancel();
        request.resolve(value);
        return;
      }
      if (frame.opcode === OUTER.OFFER) {
        requireRelay(!this.circuits.has(frame.circuitId) && this.offerHandler);
        const offer = readCanonical(C.Offer, frame.payload);
        this.offerHandler(frame.circuitId, offer);
        return;
      }
      const circuit = this.circuits.get(frame.circuitId);
      // A close may race an already queued window/data from its exact retired
      // circuit. Drop that finite old packet without affecting other circuits.
      if (
        !circuit &&
        (frame.opcode === OUTER.CLOSE ||
          frame.opcode === OUTER.WINDOW ||
          frame.opcode === OUTER.DATA)
      )
        return;
      requireRelay(circuit);
      circuit.receive(frame.opcode, frame.payload, bytes.byteLength);
    });
  }

  send(opcode: OuterOpcode, id: string, payload: unknown): void {
    requireRelay(this.connection.active, "UNAVAILABLE");
    const bytes = encodeOuter(opcode, id, canonicalBytes(payload, RELAY_LIMITS.controlBytes));
    const previous =
      opcode === OUTER.WINDOW
        ? this.controls.find((entry) => entry.opcode === OUTER.WINDOW && entry.id === id)
        : undefined;
    if (previous) {
      previous.release();
      this.controls.splice(this.controls.indexOf(previous), 1);
    }
    const release = this.controlPending.reserve(bytes.byteLength);
    requireRelay(release, "BUSY");
    const aggregate = this.resources.pending.reserve(bytes.byteLength);
    if (!aggregate) {
      release();
      throw new RelayError("BUSY");
    }
    this.controls.push({
      opcode,
      id,
      bytes,
      release: () => {
        release();
        aggregate();
      },
    });
    this.drain();
  }
  sendCiphertext(bytes: Uint8Array): boolean {
    if (!this.connection.active) return false;
    if (!this.dataRate.take(epochNow())) {
      this.schedule(this.dataRate.retryAfter(epochNow()));
      return false;
    }
    const sent = this.connection.send(bytes);
    if (!sent) this.schedule(50);
    return sent;
  }
  private schedule(delay: number): void {
    if (this.scheduledDrain || !this.connection.active) return;
    this.scheduledDrain = true;
    this.connection.lifetime.later(delay, () => {
      this.scheduledDrain = false;
      this.drain();
    });
  }
  private drain(): void {
    if (!this.connection.active) return;
    while (this.controls.length) {
      if (!this.controlRate.take(epochNow())) {
        this.schedule(this.controlRate.retryAfter(epochNow()));
        return;
      }
      const entry = this.controls[0]!;
      if (!this.connection.send(entry.bytes, true)) {
        this.schedule(50);
        return;
      }
      this.controls.shift();
      entry.release();
    }
    const circuits = [...this.circuits.values()];
    if (circuits.length) {
      const start = this.circuitCursor++ % circuits.length;
      for (let index = 0; index < circuits.length; index++)
        circuits[(start + index) % circuits.length]!.raw.onMuxerDrain();
    }
  }
  onOffer(handler: (id: string, offer: C.Offer) => void): void {
    requireRelay(!this.offerHandler);
    this.offerHandler = handler;
  }
  circuit(id: string, offer: C.Offer, direction: "viewer" | "host"): EndpointCircuit {
    requireRelay(!this.circuits.has(id) && this.circuits.size < RELAY_LIMITS.owners, "BUSY");
    const circuit = new EndpointCircuit(this, this.resources, id, offer, direction, () =>
      this.circuits.delete(id),
    );
    this.circuits.set(id, circuit);
    return circuit;
  }
  async register(
    locator: string,
    capacityToken: string,
    identity: RelayIdentity,
    priority: 0 | 1 = 0,
  ): Promise<C.Registered> {
    await this.connection.opened;
    const hello = await this.hello;
    this.priority = priority;
    const unsigned = { locator, admissionPublicKey: identity.publicKey, capacityToken, priority };
    const signature = await signBytes(identity, admissionProof(hello, unsigned));
    requireRelay(this.connection.active && hello.expiresAt > epochNow(), "EXPIRED");
    this.send(OUTER.REGISTER, ZERO_CIRCUIT, { ...unsigned, signature });
    const cancelRegistration = this.connection.lifetime.later(RELAY_LIMITS.handshakeMs, () => {
      if (!this.receivedRegistration) this.connection.retire();
    });
    const registration = await this.registered.finally(cancelRegistration);
    const renew = () => {
      if (!this.connection.active) return;
      this.send(OUTER.LEASE, ZERO_CIRCUIT, {
        registrationId: registration.registrationId,
        priority: this.priority,
      });
      this.connection.lifetime.later(RELAY_LIMITS.renewMs, renew);
    };
    this.connection.lifetime.later(RELAY_LIMITS.renewMs, renew);
    return registration;
  }
  setPriority(priority: 0 | 1): void {
    if (this.priority === priority) return;
    this.priority = priority;
    if (this.registration && this.connection.active)
      this.send(OUTER.LEASE, ZERO_CIRCUIT, {
        registrationId: this.registration.registrationId,
        priority,
      });
  }
  async mintTickets(
    registrationId: string,
    purpose: "invite" | "resume",
    admissionPublicKey: string | null,
    count = 1,
    timeoutMs: number = RELAY_LIMITS.handshakeMs,
  ): Promise<typeof C.Tickets.Type> {
    requireRelay(this.tickets.size < 8 && count >= 1 && count <= 4, "BUSY");
    const requestId = randomOpaque(16),
      result = deferred<typeof C.Tickets.Type>();
    requireRelay(timeoutMs > 0 && timeoutMs <= RELAY_LIMITS.handshakeMs);
    const cancel = this.connection.lifetime.later(timeoutMs, () => {
      const held = this.tickets.get(requestId);
      if (!held) return;
      this.tickets.delete(requestId);
      held.reject(new RelayError("UNAVAILABLE"));
    });
    this.tickets.set(requestId, { resolve: result.resolve, reject: result.reject, cancel });
    try {
      this.send(OUTER.MINT_TICKETS, ZERO_CIRCUIT, {
        requestId,
        registrationId,
        purpose,
        admissionPublicKey,
        count,
      });
    } catch {
      this.tickets.delete(requestId);
      cancel();
      throw new RelayError("UNAVAILABLE");
    }
    return result.promise;
  }
  get context(): { networkId: string; nodeId: string } {
    return { networkId: this.networkId, nodeId: this.nodeId };
  }
}

export class EndpointCircuit {
  readonly raw: RelayNoiseStream;
  readonly accepted: Promise<void>;
  readonly id: string;
  readonly offer: C.Offer;
  private readonly leg: RelayLeg;
  private readonly direction: "viewer" | "host";
  private readonly credit = new CreditWindow(RELAY_LIMITS.channelWindowBytes);
  private readonly resolveAccepted: () => void;
  private readonly rejectAccepted: (error: RelayError) => void;
  private readonly release: () => void;
  private readonly removeDrain: () => void;
  private readonly incoming: Array<{ remaining: number; header: number }> = [];
  private received = 0;
  private consumed = 0;
  private handshakeBytes = 0;
  private active = true;
  private accepting = false;
  private secured = false;
  private publishedWindow = 0;
  private cancelWindow: (() => void) | undefined;
  private cancelPartial: (() => void) | undefined;

  constructor(
    leg: RelayLeg,
    resources: RelayResources,
    id: string,
    offer: C.Offer,
    direction: "viewer" | "host",
    removed: () => void,
  ) {
    this.leg = leg;
    this.id = id;
    this.offer = offer;
    this.direction = direction;
    const owner = resources.owners.reserve();
    requireRelay(owner, "BUSY");
    // Reserve the full bounded circuit envelope before entering crypto. Native
    // leg queues are separately charged; no payload is stored in a global map.
    const bytes = resources.pending.reserve(RELAY_LIMITS.ownerPendingBytes);
    if (!bytes) {
      owner();
      requireRelay(false, "BUSY");
    }
    this.release = () => {
      owner();
      bytes();
      removed();
    };
    this.credit.update(RELAY_LIMITS.channelWindowBytes);
    const accepted = deferred<void>();
    this.accepted = accepted.promise;
    this.resolveAccepted = () => accepted.resolve();
    this.rejectAccepted = accepted.reject;
    void this.accepted.catch(() => {});
    this.raw = new RelayNoiseStream(
      direction,
      {
        write: (data) => {
          if (!this.active) throw new RelayError("UNAVAILABLE");
          const size = Math.min(
            data.byteLength,
            RELAY_LIMITS.outerBytes - RELAY_LIMITS.outerHeaderBytes,
            Math.max(0, this.credit.available - RELAY_LIMITS.outerHeaderBytes),
          );
          if (!size) return { sentBytes: 0, canSendMore: false };
          const encoded = encodeOuter(OUTER.DATA, id, data.subarray(0, size));
          if (!leg.sendCiphertext(encoded)) return { sentBytes: 0, canSendMore: false };
          requireRelay(this.credit.take(encoded.byteLength));
          return { sentBytes: size, canSendMore: false };
        },
        reset: () => this.retire(),
        // Credit follows consumed authenticated plaintext, not raw relay delivery.
        pause: () => {},
        resume: () => {},
        close: async () => {
          this.retire();
        },
      },
      (length, handshake) => {
        this.cancelPartial?.();
        this.cancelPartial = undefined;
        if (handshake) this.handshakeBytes += length;
      },
    );
    this.removeDrain = leg.connection.onDrain(() => {
      if (this.active) this.raw.onMuxerDrain();
    });
  }

  receive(opcode: OuterOpcode, payload: Uint8Array, encodedBytes: number): void {
    if (!this.active) return;
    try {
      if (opcode === OUTER.CLOSE) {
        readCanonical(C.EmptyControl, payload);
        this.retire(false);
        return;
      }
      if (opcode === OUTER.ACCEPT) {
        requireRelay(
          this.direction === "viewer" &&
            !this.accepting &&
            readCanonical(C.Accept, payload).registrationId === this.offer.registrationId,
        );
        this.accepting = true;
        this.resolveAccepted();
        return;
      }
      if (opcode === OUTER.WINDOW) {
        this.credit.update(readCanonical(C.Window, payload).ceiling);
        this.raw.onMuxerDrain();
        return;
      }
      requireRelay(opcode === OUTER.DATA && this.accepting && payload.byteLength > 0);
      requireRelay(
        this.received + encodedBytes <= this.consumed + RELAY_LIMITS.channelWindowBytes &&
          this.incoming.length < 128,
        "BUSY",
      );
      this.received += encodedBytes;
      this.incoming.push({ remaining: payload.byteLength, header: RELAY_LIMITS.outerHeaderBytes });
      this.raw.receive(payload);
      if (this.active && this.raw.pendingRecordBytes > 0 && !this.cancelPartial)
        this.cancelPartial = this.leg.connection.lifetime.later(RELAY_LIMITS.partialRecordMs, () =>
          this.retire(),
        );
    } catch {
      this.retire();
    }
  }

  accept(): void {
    requireRelay(this.direction === "host" && !this.accepting);
    this.accepting = true;
    this.leg.send(OUTER.ACCEPT, this.id, { registrationId: this.offer.registrationId });
    this.resolveAccepted();
  }

  async secure(
    identity: RelayIdentity,
    expectedHostKey?: string,
  ): Promise<{ stream: MessageStream; remotePublicKey: string }> {
    await this.accepted;
    const deadline = this.leg.connection.lifetime.deadline(RELAY_LIMITS.handshakeMs);
    try {
      const result = await secureChannel({
        identity,
        stream: this.raw,
        direction: this.direction,
        context: {
          networkId: this.leg.context.networkId,
          locator: this.offer.locator,
          registrationId: this.offer.registrationId,
          viewerCircuitNonce: this.offer.viewerCircuitNonce,
        },
        ...(expectedHostKey ? { expectedHostKey } : {}),
        signal: deadline.signal,
      });
      requireRelay(this.active && !deadline.signal.aborted, "UNAVAILABLE");
      this.secured = true;
      this.consumeWire(this.handshakeBytes);
      return result;
    } catch (error) {
      this.retire();
      throw error;
    } finally {
      deadline.cancel();
    }
  }

  /** One Noise record decrypts to one message; include its tag and length prefix. */
  consumedPlaintext(length: number): void {
    requireRelay(this.secured && this.active && Number.isSafeInteger(length) && length > 0);
    this.consumeWire(length + 18);
  }

  private consumeWire(length: number): void {
    let remaining = length;
    while (remaining > 0) {
      const first = this.incoming[0];
      requireRelay(first);
      const count = Math.min(remaining, first.remaining);
      first.remaining -= count;
      remaining -= count;
      this.consumed += count;
      if (!first.remaining) {
        this.consumed += first.header;
        this.incoming.shift();
      }
    }
    requireRelay(Number.isSafeInteger(this.consumed + RELAY_LIMITS.channelWindowBytes));
    if (this.consumed - this.publishedWindow >= 16_384) this.publishWindow();
    else if (!this.cancelWindow)
      this.cancelWindow = this.leg.connection.lifetime.later(250, () => {
        this.cancelWindow = undefined;
        this.publishWindow();
      });
  }
  private publishWindow(): void {
    if (!this.active || this.publishedWindow === this.consumed) return;
    this.cancelWindow?.();
    this.cancelWindow = undefined;
    this.publishedWindow = this.consumed;
    this.leg.send(OUTER.WINDOW, this.id, {
      ceiling: this.consumed + RELAY_LIMITS.channelWindowBytes,
    });
  }

  authorize(): void {
    requireRelay(this.direction === "host" && this.active && this.secured);
    this.leg.send(OUTER.AUTHORIZE, this.id, {});
  }
  retire(notify = true): void {
    if (!this.active) return;
    this.active = false;
    this.cancelWindow?.();
    this.cancelWindow = undefined;
    this.cancelPartial?.();
    this.cancelPartial = undefined;
    this.rejectAccepted(new RelayError("UNAVAILABLE"));
    this.removeDrain();
    this.incoming.length = 0;
    this.raw.onTransportClosed(new RelayError("UNAVAILABLE"));
    if (notify && this.leg.connection.active) {
      try {
        this.leg.send(OUTER.CLOSE, this.id, {});
      } catch {
        /* Exact circuit already retired. */
      }
    }
    this.release();
  }
  async close(_options?: AbortOptions): Promise<void> {
    this.retire();
  }
  get isActive(): boolean {
    return this.active;
  }
}
