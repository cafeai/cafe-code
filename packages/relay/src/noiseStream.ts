import type { AbortOptions, MessageStreamDirection } from "@libp2p/interface";
import { AbstractMessageStream, type SendResult } from "@libp2p/utils";
import type { Uint8ArrayList } from "uint8arraylist";
import { NOISE_LOGGER } from "./crypto.ts";
import { RelayError, requireRelay } from "./errors.ts";
import { RELAY_LIMITS } from "./limits.ts";

export interface CircuitWire {
  /** Accepted bytes stay charged to the transport until its exact native flush. */
  readonly write: (bytes: Uint8Array) => SendResult;
  readonly reset: () => void;
  readonly pause: () => void;
  readonly resume: () => void;
  readonly close: (signal?: AbortSignal) => Promise<void>;
}

/**
 * Guard the two-byte Noise length field before the upstream decoder can retain
 * arbitrary partial input. Only the incomplete record is held here; completed
 * buffers transfer to their exact downstream owner and are never reused.
 */
export class NoiseRecordGuard {
  private header = new Uint8Array(2);
  private headerUsed = 0;
  private record: Uint8Array | undefined;
  private used = 0;
  private handshakes: number;
  private handshakeBytes = 0;
  private retired = false;

  constructor(direction: "viewer" | "host") {
    this.handshakes = direction === "viewer" ? 1 : 2;
  }

  push(bytes: Uint8Array, consume: (record: Uint8Array, handshake: boolean) => void): void {
    requireRelay(!this.retired);
    let offset = 0;
    while (offset < bytes.byteLength) {
      if (!this.record) {
        while (this.headerUsed < 2 && offset < bytes.byteLength)
          this.header[this.headerUsed++] = bytes[offset++]!;
        if (this.headerUsed < 2) return;
        const length = (this.header[0]! << 8) | this.header[1]!;
        const maximum =
          this.handshakes > 0
            ? RELAY_LIMITS.noiseHandshakeMessageBytes
            : RELAY_LIMITS.noiseRecordBytes;
        requireRelay(length >= 16 && length <= maximum);
        if (this.handshakes > 0) {
          this.handshakeBytes += length + 2;
          requireRelay(this.handshakeBytes <= RELAY_LIMITS.noiseHandshakeBytes);
        }
        this.record = new Uint8Array(length + 2);
        this.record.set(this.header);
        this.used = 2;
      }
      const amount = Math.min(this.record.byteLength - this.used, bytes.byteLength - offset);
      this.record.set(bytes.subarray(offset, offset + amount), this.used);
      offset += amount;
      this.used += amount;
      if (this.used === this.record.byteLength) {
        const complete = this.record;
        this.record = undefined;
        this.used = 0;
        this.headerUsed = 0;
        const handshake = this.handshakes > 0;
        if (handshake) this.handshakes--;
        consume(complete, handshake);
      }
    }
  }

  retire(): void {
    this.retired = true;
    this.record?.fill(0);
    this.record = undefined;
    this.header.fill(0);
  }

  get pendingBytes(): number {
    return this.record?.byteLength ?? this.headerUsed;
  }
}

/** Public MessageStream implementation over an admitted, bounded Cafe circuit. */
export class RelayNoiseStream extends AbstractMessageStream {
  private readonly wire: CircuitWire;
  private readonly guard: NoiseRecordGuard;
  private readonly observedRecord: (bytes: number, handshake: boolean) => void;

  constructor(
    direction: "viewer" | "host",
    wire: CircuitWire,
    observedRecord: (bytes: number, handshake: boolean) => void = () => {},
  ) {
    const streamDirection: MessageStreamDirection = direction === "viewer" ? "outbound" : "inbound";
    super({
      log: NOISE_LOGGER,
      direction: streamDirection,
      maxReadBufferLength: RELAY_LIMITS.noiseRecordBytes + 2,
      maxWriteBufferLength: RELAY_LIMITS.noiseRecordBytes + 2,
      maxMessageSize: RELAY_LIMITS.outerBytes - RELAY_LIMITS.outerHeaderBytes,
    });
    this.wire = wire;
    this.guard = new NoiseRecordGuard(direction);
    this.observedRecord = observedRecord;
  }

  receive(bytes: Uint8Array): void {
    if (this.status !== "open") return;
    try {
      requireRelay(bytes.byteLength <= RELAY_LIMITS.outerBytes);
      this.guard.push(bytes, (record, handshake) => {
        this.observedRecord(record.byteLength, handshake);
        this.onData(record);
      });
    } catch {
      this.abort(new RelayError("PROTOCOL_ERROR"));
    }
  }

  override sendData(data: Uint8ArrayList): SendResult {
    return this.wire.write(data.subarray());
  }

  override sendReset(): void {
    this.guard.retire();
    this.wire.reset();
  }

  override sendPause(): void {
    this.wire.pause();
  }
  override sendResume(): void {
    this.wire.resume();
  }

  override async close(options?: AbortOptions): Promise<void> {
    await this.wire.close(options?.signal);
    this.guard.retire();
    super.onTransportClosed();
  }

  override onTransportClosed(error?: Error): void {
    this.guard.retire();
    super.onTransportClosed(error ? new RelayError("UNAVAILABLE") : undefined);
  }
  get pendingRecordBytes(): number {
    return this.guard.pendingBytes;
  }
}
