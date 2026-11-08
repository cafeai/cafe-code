import { deferred } from "./deferred.ts";
import type { MessageStream } from "@libp2p/interface";
import * as Schema from "effect/Schema";
import { Budget, CreditWindow, TokenBucket } from "./budget.ts";
import { randomOpaque } from "./bytes.ts";
import type { RelayIdentity } from "./crypto.ts";
import { RelayError, requireRelay } from "./errors.ts";
import type { EndpointCircuit } from "./leg.ts";
import { epochNow, Lifetime } from "./lifetime.ts";
import { RELAY_LIMITS } from "./limits.ts";
import {
  INNER,
  Id16,
  Id32,
  InnerDecoder,
  SafeCounter,
  canonicalBytes,
  encodeInner,
  readCanonical,
  type InnerFrame,
  type InnerKind,
} from "./protocol.ts";

const Binding = Schema.Struct({
  nonce: Id16,
  viewerCircuitNonce: Id16,
  devicePublicKey: Id32,
  admissionPublicKey: Id32,
});
const BindingAck = Schema.Struct({ nonce: Id16, hostNonce: Id16, viewerCircuitNonce: Id16 });
export const SessionAuth = Schema.Struct({
  environmentId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  operation: Schema.Literals(["pair", "resume", "password"]),
  credential: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  secondFactor: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  ),
});
export type SessionAuth = typeof SessionAuth.Type;
export const ResumeTicket = Schema.Struct({
  nodeId: Id32,
  registrationId: Id16,
  admissionPublicKey: Id32,
  token: Id32,
  expiresAt: SafeCounter,
});
export type ResumeTicket = typeof ResumeTicket.Type;
export const SessionAuthResult = Schema.Struct({
  environmentId: Schema.String.check(Schema.isMaxLength(128)),
  bearerToken: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  role: Schema.Literals(["client", "owner"]),
  expiresAt: SafeCounter,
  transportTickets: Schema.optionalKey(Schema.Array(ResumeTicket).check(Schema.isMaxLength(4))),
});
export type SessionAuthResult = typeof SessionAuthResult.Type;
const Denied = Schema.Struct({
  code: Schema.Literals([
    "AUTH_REJECTED",
    "SECOND_FACTOR_REQUIRED",
    "SECOND_FACTOR_LOCKED",
    "SESSION_REVOKED",
    "ENVIRONMENT_MISMATCH",
    "UNAVAILABLE",
  ]),
});
const Credit = Schema.Struct({
  channelCeiling: SafeCounter,
  streamId: SafeCounter,
  streamCeiling: SafeCounter,
});
const Final = Schema.Struct({ bytes: SafeCounter });
const Reset = Schema.Struct({
  code: Schema.Literals(["BUSY", "INCOMPLETE", "UNAVAILABLE", "PROTOCOL_ERROR", "AUTH_REJECTED"]),
});
const Heartbeat = Schema.Struct({ nonce: Id16 });
const Open = Schema.Struct({ kind: Schema.Literals(["http", "rpc"]), metadata: Schema.Unknown });
export type StreamKind = typeof Open.Type.kind;
export interface SessionHandlers {
  readonly authenticate?: (
    input: SessionAuth,
    devicePublicKey: string,
  ) => Promise<SessionAuthResult>;
  readonly open?: (stream: RelayStream, metadata: unknown) => Promise<void>;
  readonly validate?: (auth: SessionAuthResult, devicePublicKey: string) => Promise<void>;
  readonly tickets?: () => Promise<readonly ResumeTicket[]>;
}
interface PendingSend {
  readonly encoded: Uint8Array;
  readonly stream: RelayStream | undefined;
  readonly resolve: () => void;
  readonly reject: (error: RelayError) => void;
  readonly release: () => void;
}

/** Encrypted application multiplexing. This owner never owns provider work. */
export class RelaySession {
  private readonly jobs = new Set<Promise<void>>();
  private openHandlers = 0;
  private bulkHandlers = 0;
  private track(job: Promise<unknown>): void {
    const settled = job.then(
      () => {},
      () => {
        this.retire();
      },
    );
    this.jobs.add(settled);
    void settled.then(() => this.jobs.delete(settled));
  }
  readonly circuit: EndpointCircuit;
  readonly remotePublicKey: string;
  readonly closed: Promise<void>;
  readonly bound: Promise<void>;
  readonly authorized: Promise<SessionAuthResult>;
  private readonly resolveClosed: () => void;
  private readonly resolveBound: () => void;
  private readonly rejectBound: (error: RelayError) => void;
  private readonly resolveAuthorized: (result: SessionAuthResult) => void;
  private readonly rejectAuthorized: (error: RelayError) => void;
  private readonly stream: MessageStream;
  private readonly direction: "viewer" | "host";
  private readonly handlers: SessionHandlers;
  private readonly lifetime = new Lifetime(() => this.retire());
  private readonly decoder = new InnerDecoder();
  private readonly receiveBudget = new Budget(RELAY_LIMITS.channelWindowBytes);
  private readonly sendBudget = new Budget(RELAY_LIMITS.channelWindowBytes);
  private readonly controlBudget = new Budget(RELAY_LIMITS.controlReserveBytes);
  private readonly sendCredit = new CreditWindow(RELAY_LIMITS.channelWindowBytes);
  private readonly controls = new TokenBucket(64, 32, epochNow());
  private readonly streams = new Map<number, RelayStream>();
  private readonly pending = new Map<number, PendingSend>();
  private readonly controlQueue: PendingSend[] = [];
  private readonly nonce = randomOpaque(16);
  private nextId: number;
  private lastRemoteId = 0;
  private received = 0;
  private consumed = 0;
  private blocked = false;
  private flushing = false;
  private bindingReceived = false;
  private authenticated: SessionAuthResult | undefined;
  private authPending = false;
  private authReply: ReturnType<typeof deferred<SessionAuthResult>> | undefined;
  private pingNonce: string | undefined;
  private lastPong = epochNow();
  private records = 0;
  private retired = false;
  private cancelPartial: (() => void) | undefined;

  private constructor(
    circuit: EndpointCircuit,
    direction: "viewer" | "host",
    secured: { stream: MessageStream; remotePublicKey: string },
    identity: RelayIdentity,
    handlers: SessionHandlers,
  ) {
    this.circuit = circuit;
    this.direction = direction;
    this.stream = secured.stream;
    this.remotePublicKey = secured.remotePublicKey;
    this.handlers = handlers;
    this.nextId = direction === "viewer" ? 1 : 2;
    const closed = deferred<void>(),
      bound = deferred<void>();
    this.closed = closed.promise;
    this.resolveClosed = () => closed.resolve();
    this.bound = bound.promise;
    this.resolveBound = () => bound.resolve();
    this.rejectBound = bound.reject;
    const authorized = deferred<SessionAuthResult>();
    this.authorized = authorized.promise;
    this.resolveAuthorized = authorized.resolve;
    this.rejectAuthorized = authorized.reject;
    void this.authorized.catch(() => {});
    void this.bound.catch(() => {});
    this.sendCredit.update(RELAY_LIMITS.channelWindowBytes);
    this.stream.addEventListener("message", (event) => {
      if (!this.lifetime.active) return;
      try {
        const bytes = event.data.subarray();
        const frames = this.decoder.push(bytes);
        if (frames.length) {
          this.cancelPartial?.();
          this.cancelPartial = undefined;
        }
        for (const frame of frames) this.receive(frame);
        if (this.decoder.pendingBytes > 0 && !this.cancelPartial)
          this.cancelPartial = this.lifetime.later(RELAY_LIMITS.partialRecordMs, () =>
            this.retire(),
          );
        // The library emits one decrypted message per length-prefixed record.
        // Only authenticated parsing/retention admitted above returns outer credit.
        circuit.consumedPlaintext(bytes.byteLength);
      } catch {
        this.retire();
      }
    });
    this.stream.addEventListener("close", () => this.retire());
    this.stream.addEventListener("drain", () => {
      this.blocked = false;
      this.flush();
    });
    this.lifetime.later(RELAY_LIMITS.channelLifetimeMs, () => this.retire());
    this.lifetime.later(RELAY_LIMITS.handshakeMs, () => {
      if (!this.bindingReceived) this.retire();
    });
    this.lifetime.later(
      circuit.offer.recovery ? RELAY_LIMITS.recoveryMs : RELAY_LIMITS.handshakeMs,
      () => {
        if (!this.authenticated) this.retire();
      },
    );
    this.heartbeat();
    if (direction === "viewer")
      this.control(INNER.BIND, {
        nonce: this.nonce,
        viewerCircuitNonce: circuit.offer.viewerCircuitNonce,
        devicePublicKey: identity.publicKey,
        admissionPublicKey: circuit.offer.admissionPublicKey,
      });
  }

  static async open(input: {
    readonly circuit: EndpointCircuit;
    readonly direction: "viewer" | "host";
    readonly identity: RelayIdentity;
    readonly expectedHostKey?: string;
    readonly handlers?: SessionHandlers;
  }): Promise<RelaySession> {
    const secured = await input.circuit.secure(input.identity, input.expectedHostKey);
    return new RelaySession(
      input.circuit,
      input.direction,
      secured,
      input.identity,
      input.handlers ?? {},
    );
  }

  private control(kind: InnerKind, value: unknown, streamId = 0): void {
    if (!this.lifetime.active) return;
    const encoded = encodeInner(kind, streamId, canonicalBytes(value));
    const release = this.controlBudget.reserve(encoded.byteLength);
    requireRelay(release, "BUSY");
    this.controlQueue.push({
      encoded,
      stream: undefined,
      resolve: () => {},
      reject: () => {},
      release,
    });
    this.flush();
  }

  send(kind: InnerKind, stream: RelayStream, payload: Uint8Array): Promise<void> {
    requireRelay(
      this.lifetime.active && this.authenticated && !this.pending.has(stream.id),
      "BUSY",
    );
    const encoded = encodeInner(kind, stream.id, payload),
      release = this.sendBudget.reserve(encoded.byteLength);
    requireRelay(release, "BUSY");
    const result = deferred<void>();
    this.pending.set(stream.id, {
      encoded,
      stream,
      release,
      resolve: () => result.resolve(),
      reject: result.reject,
    });
    this.flush();
    return result.promise;
  }

  private flush(): void {
    if (!this.lifetime.active || this.blocked || this.flushing) return;
    this.flushing = true;
    try {
      while (!this.blocked && this.lifetime.active) {
        let entry = this.controlQueue.shift();
        if (!entry) {
          for (const [id, candidate] of this.pending) {
            if (
              !candidate.stream ||
              candidate.encoded.byteLength > this.sendCredit.available ||
              candidate.encoded.byteLength > candidate.stream.sendCredit.available
            )
              continue;
            this.pending.delete(id);
            requireRelay(
              this.sendCredit.take(candidate.encoded.byteLength) &&
                candidate.stream.sendCredit.take(candidate.encoded.byteLength),
            );
            entry = candidate;
            break;
          }
        }
        if (!entry) break;
        try {
          requireRelay(++this.records < RELAY_LIMITS.channelRecords, "EXPIRED");
          this.blocked = !this.stream.send(entry.encoded);
          entry.resolve();
        } catch {
          entry.reject(new RelayError("UNAVAILABLE"));
          this.retire();
        } finally {
          entry.release();
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private receive(frame: InnerFrame): void {
    requireRelay(++this.records < RELAY_LIMITS.channelRecords, "EXPIRED");
    if (frame.streamId === 0) {
      requireRelay(this.controls.take(epochNow()), "BUSY");
      this.receiveControl(frame);
      return;
    }
    requireRelay(this.authenticated && this.bindingReceived, "AUTH_REQUIRED");
    if (frame.kind === INNER.RESET) {
      readCanonical(Reset, frame.payload);
      this.streams.get(frame.streamId)?.retire(new RelayError("INCOMPLETE"), false);
      return;
    }
    let stream = this.streams.get(frame.streamId);
    if (frame.kind === INNER.OPEN) {
      requireRelay(
        !stream &&
          frame.streamId > this.lastRemoteId &&
          frame.streamId % 2 === (this.direction === "viewer" ? 0 : 1),
      );
      this.lastRemoteId = frame.streamId;
      const open = readCanonical(Open, frame.payload);
      if (
        this.streams.size >= RELAY_LIMITS.streams ||
        this.openHandlers >= RELAY_LIMITS.streams ||
        (open.kind === "http" &&
          (this.bulkCount >= RELAY_LIMITS.bulkStreams ||
            this.bulkHandlers >= RELAY_LIMITS.bulkStreams))
      ) {
        this.admitReceived(frame.encodedBytes);
        this.consumed += frame.encodedBytes;
        this.control(INNER.CREDIT, {
          channelCeiling: this.consumed + RELAY_LIMITS.channelWindowBytes,
          streamId: frame.streamId,
          streamCeiling: RELAY_LIMITS.streamWindowBytes,
        });
        this.control(INNER.RESET, { code: "BUSY" }, frame.streamId);
        return;
      }
      stream = new RelayStream(this, frame.streamId, open.kind, false);
      this.streams.set(frame.streamId, stream);
      this.admitReceived(frame.encodedBytes);
      stream.admit(frame.encodedBytes);
      this.consume(stream, frame.encodedBytes);
      if (!this.handlers.open) {
        stream.retire(new RelayError("PROTOCOL_ERROR"));
        return;
      }
      const held = stream;
      this.openHandlers++;
      if (open.kind === "http") this.bulkHandlers++;
      this.track(
        Promise.resolve()
          .then(() => {
            if (this.lifetime.active && held.active)
              return this.handlers.open!(held, open.metadata);
          })
          .catch(() => held.retire(new RelayError("UNAVAILABLE")))
          .finally(() => {
            this.openHandlers--;
            if (open.kind === "http") this.bulkHandlers--;
          }),
      );
      return;
    }
    if (!stream) {
      // RESET can cross already-admitted DATA/FIN in the opposite direction.
      // Drain only retired IDs below this channel's monotonic allocation
      // watermark, without retaining or delivering their payload. Channel
      // credit and the native frame/rate limits still bound every byte. A
      // future/unallocated ID never obtains application or stream authority.
      const locallyAllocated = frame.streamId % 2 === (this.direction === "viewer" ? 1 : 0);
      requireRelay(
        frame.streamId > 0 &&
          (locallyAllocated ? frame.streamId < this.nextId : frame.streamId <= this.lastRemoteId),
      );
      requireRelay(frame.kind === INNER.DATA || frame.kind === INNER.FIN);
      if (frame.kind === INNER.DATA)
        requireRelay(
          frame.payload.byteLength > 0 && frame.payload.byteLength <= RELAY_LIMITS.dataBytes,
        );
      else readCanonical(Final, frame.payload);
      this.admitReceived(frame.encodedBytes);
      this.consumed += frame.encodedBytes;
      this.control(INNER.CREDIT, {
        channelCeiling: this.consumed + RELAY_LIMITS.channelWindowBytes,
        streamId: frame.streamId,
        streamCeiling: RELAY_LIMITS.streamWindowBytes,
      });
      return;
    }
    this.admitReceived(frame.encodedBytes);
    stream.admit(frame.encodedBytes);
    if (frame.kind === INNER.DATA) {
      requireRelay(
        frame.payload.byteLength > 0 && frame.payload.byteLength <= RELAY_LIMITS.dataBytes,
      );
      const release = this.receiveBudget.reserve(frame.encodedBytes);
      requireRelay(release, "BUSY");
      stream.receivedData(frame.payload, frame.encodedBytes, release);
      return;
    }
    if (frame.kind === INNER.OPEN_OK) {
      stream.receivedMetadata(readCanonical(Schema.Unknown, frame.payload));
      this.consume(stream, frame.encodedBytes);
      return;
    }
    requireRelay(frame.kind === INNER.FIN);
    stream.receivedFin(readCanonical(Final, frame.payload).bytes);
    this.consume(stream, frame.encodedBytes);
  }

  private admitReceived(bytes: number): void {
    this.received += bytes;
    requireRelay(
      Number.isSafeInteger(this.received) &&
        this.received <= this.consumed + RELAY_LIMITS.channelWindowBytes,
    );
  }
  consume(stream: RelayStream, bytes: number): void {
    if (!this.lifetime.active) return;
    this.consumed += bytes;
    stream.consumed += bytes;
    requireRelay(
      Number.isSafeInteger(this.consumed + RELAY_LIMITS.channelWindowBytes) &&
        Number.isSafeInteger(stream.consumed + RELAY_LIMITS.streamWindowBytes),
    );
    this.control(INNER.CREDIT, {
      channelCeiling: this.consumed + RELAY_LIMITS.channelWindowBytes,
      streamId: stream.id,
      streamCeiling: stream.consumed + RELAY_LIMITS.streamWindowBytes,
    });
  }

  private receiveControl(frame: InnerFrame): void {
    if (frame.kind === INNER.BIND) {
      requireRelay(this.direction === "host" && !this.bindingReceived);
      const binding = readCanonical(Binding, frame.payload);
      requireRelay(
        binding.viewerCircuitNonce === this.circuit.offer.viewerCircuitNonce &&
          binding.devicePublicKey === this.remotePublicKey,
        "HOST_IDENTITY_MISMATCH",
      );
      requireRelay(binding.admissionPublicKey === this.circuit.offer.admissionPublicKey);
      this.bindingReceived = true;
      this.control(INNER.BIND_ACK, {
        nonce: binding.nonce,
        hostNonce: this.nonce,
        viewerCircuitNonce: binding.viewerCircuitNonce,
      });
      this.resolveBound();
      return;
    }
    if (frame.kind === INNER.BIND_ACK) {
      requireRelay(this.direction === "viewer" && !this.bindingReceived);
      const binding = readCanonical(BindingAck, frame.payload);
      requireRelay(
        binding.nonce === this.nonce &&
          binding.viewerCircuitNonce === this.circuit.offer.viewerCircuitNonce,
      );
      this.bindingReceived = true;
      this.resolveBound();
      return;
    }
    requireRelay(this.bindingReceived);
    if (frame.kind === INNER.AUTH) {
      requireRelay(
        this.direction === "host" &&
          !this.authenticated &&
          !this.authPending &&
          this.handlers.authenticate,
      );
      const input = readCanonical(SessionAuth, frame.payload);
      this.authPending = true;
      this.track(
        Promise.resolve()
          .then(() =>
            this.lifetime.active
              ? this.handlers.authenticate!(input, this.remotePublicKey)
              : Promise.reject(new RelayError("UNAVAILABLE")),
          )
          .then(async (result) => {
            if (!this.lifetime.active) return;
            const decoded = readCanonical(SessionAuthResult, canonicalBytes(result));
            requireRelay(decoded.environmentId === input.environmentId, "ENVIRONMENT_MISMATCH");
            this.authenticated = decoded;
            this.authPending = false;
            this.circuit.authorize();
            const transportTickets = (await this.handlers.tickets?.().catch(() => [])) ?? [];
            if (!this.lifetime.active) return;
            const response = { ...decoded, transportTickets };
            readCanonical(SessionAuthResult, canonicalBytes(response));
            this.authenticated = response;
            this.resolveAuthorized(response);
            this.control(INNER.AUTH_OK, response);
            this.renewAuthorization();
          })
          .catch((error) => {
            if (!this.lifetime.active) return;
            this.authPending = false;
            const code =
              error instanceof RelayError &&
              [
                "SECOND_FACTOR_REQUIRED",
                "SECOND_FACTOR_LOCKED",
                "SESSION_REVOKED",
                "ENVIRONMENT_MISMATCH",
              ].includes(error.code)
                ? error.code
                : "AUTH_REJECTED";
            try {
              this.control(INNER.AUTH_DENIED, { code });
            } catch {
              this.retire();
            }
          }),
      );
      return;
    }
    if (frame.kind === INNER.AUTH_OK) {
      requireRelay(this.direction === "viewer" && this.authReply && !this.authenticated);
      const result = readCanonical(SessionAuthResult, frame.payload);
      this.authenticated = result;
      this.resolveAuthorized(result);
      this.authReply.resolve(result);
      this.authReply = undefined;
      return;
    }
    if (frame.kind === INNER.AUTH_DENIED) {
      requireRelay(this.direction === "viewer" && this.authReply);
      const result = readCanonical(Denied, frame.payload);
      this.authReply.reject(new RelayError(result.code));
      this.authReply = undefined;
      return;
    }
    if (frame.kind === INNER.PING) {
      this.control(INNER.PONG, readCanonical(Heartbeat, frame.payload));
      return;
    }
    if (frame.kind === INNER.PONG) {
      const pong = readCanonical(Heartbeat, frame.payload);
      requireRelay(pong.nonce === this.pingNonce);
      this.pingNonce = undefined;
      this.lastPong = epochNow();
      return;
    }
    if (frame.kind === INNER.GOAWAY) {
      this.retire();
      return;
    }
    requireRelay(frame.kind === INNER.CREDIT && this.authenticated);
    const credit = readCanonical(Credit, frame.payload);
    this.sendCredit.update(credit.channelCeiling);
    const target = this.streams.get(credit.streamId);
    if (target) target.sendCredit.update(credit.streamCeiling);
    else requireRelay(credit.streamId < this.nextId || credit.streamId <= this.lastRemoteId);
    this.flush();
  }

  async authenticate(input: SessionAuth): Promise<SessionAuthResult> {
    await this.bound;
    requireRelay(
      this.direction === "viewer" && this.lifetime.active && !this.authenticated && !this.authReply,
    );
    this.authReply = deferred<SessionAuthResult>();
    const reply = this.authReply.promise;
    this.control(INNER.AUTH, input);
    const result = await reply;
    requireRelay(result.environmentId === input.environmentId, "ENVIRONMENT_MISMATCH");
    return result;
  }

  async open(kind: StreamKind, metadata: unknown): Promise<RelayStream> {
    requireRelay(
      this.authenticated &&
        this.lifetime.active &&
        this.streams.size < RELAY_LIMITS.streams &&
        this.nextId <= 0xffff_ffff,
      "BUSY",
    );
    requireRelay(kind !== "http" || this.bulkCount < RELAY_LIMITS.bulkStreams, "BUSY");
    const stream = new RelayStream(this, this.nextId, kind, true);
    this.nextId += 2;
    this.streams.set(stream.id, stream);
    try {
      await this.send(INNER.OPEN, stream, canonicalBytes({ kind, metadata }));
      return stream;
    } catch (error) {
      stream.retire(new RelayError("UNAVAILABLE"));
      throw error;
    }
  }

  reset(stream: RelayStream): void {
    const pending = this.pending.get(stream.id);
    if (pending) {
      this.pending.delete(stream.id);
      pending.release();
      pending.reject(new RelayError("INCOMPLETE"));
    }
    if (this.lifetime.active) this.control(INNER.RESET, { code: "INCOMPLETE" }, stream.id);
    this.remove(stream);
  }
  remove(stream: RelayStream): void {
    if (this.streams.get(stream.id) === stream) this.streams.delete(stream.id);
  }
  private get bulkCount(): number {
    let count = 0;
    for (const stream of this.streams.values()) if (stream.kind === "http") count++;
    return count;
  }
  private renewAuthorization(): void {
    this.lifetime.later(RELAY_LIMITS.renewMs, () => {
      const auth = this.authenticated;
      if (!auth) return;
      this.track(
        Promise.resolve()
          .then(() =>
            this.lifetime.active ? this.handlers.validate?.(auth, this.remotePublicKey) : undefined,
          )
          .then(() => {
            if (!this.lifetime.active || this.authenticated !== auth) return;
            this.circuit.authorize();
            this.renewAuthorization();
          })
          .catch(() => this.retire()),
      );
    });
  }
  private heartbeat(): void {
    this.lifetime.later(RELAY_LIMITS.pingMs, () => {
      if (epochNow() - this.lastPong >= RELAY_LIMITS.pongMs) {
        this.retire();
        return;
      }
      if (this.bindingReceived && !this.pingNonce) {
        this.pingNonce = randomOpaque(16);
        this.control(INNER.PING, { nonce: this.pingNonce });
      }
      this.heartbeat();
    });
  }
  retire(): void {
    if (this.retired) return;
    this.retired = true;
    this.lifetime.retire();
    const error = new RelayError("INCOMPLETE");
    this.rejectBound(error);
    this.authReply?.reject(new RelayError("AUTH_INDETERMINATE"));
    this.authReply = undefined;
    this.rejectAuthorized(error);
    for (const stream of [...this.streams.values()]) stream.retire(error, false);
    for (const pending of this.pending.values()) {
      pending.release();
      pending.reject(error);
    }
    this.pending.clear();
    for (const pending of this.controlQueue.splice(0)) pending.release();
    this.decoder.retire();
    this.stream.abort(error);
    this.circuit.retire();
    this.resolveClosed();
  }
  async close(): Promise<void> {
    this.retire();
    await this.closed;
    await this.lifetime.close();
    await Promise.all(this.jobs);
  }
  get auth(): SessionAuthResult | undefined {
    return this.authenticated;
  }
  get active(): boolean {
    return this.lifetime.active;
  }
}

export class RelayStream {
  readonly id: number;
  readonly kind: StreamKind;
  readonly metadata: Promise<unknown>;
  readonly incomingComplete: Promise<number>;
  readonly sendCredit = new CreditWindow(RELAY_LIMITS.streamWindowBytes);
  consumed = 0;
  private readonly session: RelaySession;
  private readonly local: boolean;
  private readonly resolveMetadata: (metadata: unknown) => void;
  private readonly rejectMetadata: (error: RelayError) => void;
  private readonly resolveIncoming: (bytes: number) => void;
  private readonly rejectIncoming: (error: RelayError) => void;
  private readonly queue: Array<{ payload: Uint8Array; cost: number; release: () => void }> = [];
  private reader: ReturnType<typeof deferred<Uint8Array | undefined>> | undefined;
  private failed: RelayError | undefined;
  private metadataReceived = false;
  private outgoingFinished = false;
  private incomingFinished = false;
  private writing = false;
  private receivedBytes = 0;
  private sentBytes = 0;
  private receivedCost = 0;
  private retired = false;

  constructor(session: RelaySession, id: number, kind: StreamKind, local: boolean) {
    this.session = session;
    this.id = id;
    this.kind = kind;
    this.local = local;
    const metadata = deferred<unknown>();
    this.metadata = metadata.promise;
    this.resolveMetadata = metadata.resolve;
    this.rejectMetadata = metadata.reject;
    const incoming = deferred<number>();
    this.incomingComplete = incoming.promise;
    this.resolveIncoming = incoming.resolve;
    this.rejectIncoming = incoming.reject;
    void this.incomingComplete.catch(() => {});
    void this.metadata.catch(() => {});
    this.sendCredit.update(RELAY_LIMITS.streamWindowBytes);
  }
  admit(cost: number): void {
    this.receivedCost += cost;
    requireRelay(
      Number.isSafeInteger(this.receivedCost) &&
        this.receivedCost <= this.consumed + RELAY_LIMITS.streamWindowBytes,
    );
  }
  async accept(metadata: unknown): Promise<void> {
    requireRelay(!this.local && !this.metadataReceived && !this.failed);
    this.metadataReceived = true;
    this.resolveMetadata(metadata);
    await this.session.send(INNER.OPEN_OK, this, canonicalBytes(metadata));
  }
  receivedMetadata(metadata: unknown): void {
    requireRelay(this.local && !this.metadataReceived);
    this.metadataReceived = true;
    this.resolveMetadata(metadata);
  }
  receivedData(payload: Uint8Array, cost: number, release: () => void): void {
    try {
      requireRelay(!this.incomingFinished && (!this.local || this.metadataReceived));
      this.receivedBytes += payload.byteLength;
      requireRelay(Number.isSafeInteger(this.receivedBytes));
      this.queue.push({ payload, cost, release });
      this.drain();
    } catch (error) {
      release();
      throw error;
    }
  }
  receivedFin(bytes: number): void {
    requireRelay(!this.incomingFinished && bytes === this.receivedBytes, "INCOMPLETE");
    this.incomingFinished = true;
    this.resolveIncoming(bytes);
    this.drain();
  }
  private drain(): void {
    if (!this.reader) return;
    const item = this.queue.shift();
    if (item) {
      const reader = this.reader;
      this.reader = undefined;
      item.release();
      this.session.consume(this, item.cost);
      reader.resolve(item.payload);
    } else if (this.incomingFinished) {
      this.reader.resolve(undefined);
      this.reader = undefined;
      this.maybeComplete();
    }
  }
  read(): Promise<Uint8Array | undefined> {
    if (this.failed) return Promise.reject(this.failed);
    requireRelay(!this.reader);
    this.reader = deferred<Uint8Array | undefined>();
    const result = this.reader.promise;
    this.drain();
    return result;
  }
  async write(bytes: Uint8Array): Promise<void> {
    requireRelay(
      !this.failed &&
        !this.outgoingFinished &&
        !this.writing &&
        bytes.byteLength > 0 &&
        bytes.byteLength <= RELAY_LIMITS.dataBytes,
    );
    this.writing = true;
    try {
      await this.session.send(INNER.DATA, this, bytes);
      this.sentBytes += bytes.byteLength;
      requireRelay(Number.isSafeInteger(this.sentBytes));
    } finally {
      this.writing = false;
    }
  }
  async finish(): Promise<void> {
    requireRelay(!this.failed && !this.outgoingFinished && !this.writing);
    await this.session.send(INNER.FIN, this, canonicalBytes({ bytes: this.sentBytes }));
    this.outgoingFinished = true;
    this.maybeComplete();
  }
  private maybeComplete(): void {
    if (!this.incomingFinished || !this.outgoingFinished || this.queue.length || this.retired)
      return;
    this.retired = true;
    this.session.remove(this);
  }
  retire(error = new RelayError("INCOMPLETE"), notify = true): void {
    if (this.retired) return;
    this.retired = true;
    this.failed = error;
    this.rejectMetadata(error);
    this.reader?.reject(error);
    this.reader = undefined;
    this.rejectIncoming(error);
    for (const item of this.queue.splice(0)) {
      item.release();
      this.session.consume(this, item.cost);
    }
    if (notify) this.session.reset(this);
    else this.session.remove(this);
  }
  get active(): boolean {
    return !this.retired;
  }
  get owner(): RelaySession {
    return this.session;
  }
  get remoteFinished(): boolean {
    return this.incomingFinished;
  }
}
