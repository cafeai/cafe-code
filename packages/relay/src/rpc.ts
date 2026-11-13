import * as Schema from "effect/Schema";
import { Budget } from "./budget.ts";
import { RelayError, requireRelay } from "./errors.ts";
import { RELAY_DATA_CHUNK_BYTES, RELAY_LIMITS } from "./limits.ts";
import { canonicalBytes, readCanonical } from "./protocol.ts";
import type { RelayStream } from "./session.ts";

export const RELAY_RPC_COMPRESSION_HEADER = "x-cafe-relay-rpc-encoding";
const encoding = "gzip-records-v1";
const compressedProtocol = "ndjson-gzip-records-v1";
const RpcReply = Schema.Struct({ protocol: Schema.Literals(["ndjson", compressedProtocol]) });
export type RelayRpcProtocol = typeof RpcReply.Type.protocol;
export const RELAY_RPC_RECORD_BYTES = 65_536;
const headerBytes = 9;
// Separate application-codec workspace, not additional transport credit. It
// includes bounded input/output copies; native codec state has no shared context.
const workspaceBytes = RELAY_RPC_RECORD_BYTES * 5 + 1024;
const codecBudget = new Budget(RELAY_LIMITS.aggregatePendingBytes);

function supported(): boolean {
  return typeof CompressionStream === "function" && typeof DecompressionStream === "function";
}

/** Existing OPEN metadata lets old hosts ignore the offer on the same stream. */
export function relayRpcHeaders(): Array<[string, string]> {
  return supported() ? [[RELAY_RPC_COMPRESSION_HEADER, encoding]] : [];
}

export function relayRpcProtocol(
  headers: readonly (readonly [string, string])[],
): RelayRpcProtocol {
  const offers = headers.filter(([name]) => name === RELAY_RPC_COMPRESSION_HEADER);
  return supported() && offers.length === 1 && offers[0]![1] === encoding
    ? compressedProtocol
    : "ndjson";
}

export function readRelayRpcProtocol(
  metadata: unknown,
  offered: readonly (readonly [string, string])[],
): RelayRpcProtocol {
  const { protocol } = readCanonical(RpcReply, canonicalBytes(metadata));
  requireRelay(protocol === "ndjson" || relayRpcProtocol(offered) === protocol);
  return protocol;
}

/** One finite record per native codec; no dictionary crosses RPC writes. */
async function gzip(
  input: Uint8Array,
  decompress: boolean,
  maximum: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  requireRelay(!signal.aborted, "INCOMPLETE");
  const transform = decompress ? new DecompressionStream("gzip") : new CompressionStream("gzip");
  const reader = transform.readable.getReader(),
    writer = transform.writable.getWriter();
  const cancellations: Promise<unknown>[] = [];
  let cancelled = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    const error = new RelayError("INCOMPLETE");
    cancellations.push(
      reader.cancel(error).catch(() => {}),
      writer.abort(error).catch(() => {}),
    );
  };
  signal.addEventListener("abort", cancel, { once: true });
  const produce = (async () => {
    await writer.write(input.slice());
    await writer.close();
  })();
  const consume = (async () => {
    const output = new Uint8Array(maximum);
    let length = 0;
    for (;;) {
      const next = await reader.read();
      requireRelay(!signal.aborted, "INCOMPLETE");
      if (next.done) break;
      requireRelay(next.value.byteLength <= maximum - length, "INCOMPLETE");
      output.set(next.value, length);
      length += next.value.byteLength;
    }
    return output.subarray(0, length);
  })();
  try {
    const [output] = await Promise.all([consume, produce]);
    requireRelay(!signal.aborted, "INCOMPLETE");
    return output;
  } catch {
    cancel();
    // Join the exact reader/writer before releasing their workspace reservation.
    await Promise.allSettled([produce, consume, ...cancellations]);
    throw new RelayError("INCOMPLETE");
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
    writer.releaseLock();
  }
}

type RpcStream = Pick<RelayStream, "signal" | "read" | "write" | "finish" | "retire">;

/** Optional record framing lives inside Noise, below the unchanged NDJSON guard. */
export class RelayRpcTransport {
  private readonly stream: RpcStream;
  private readonly compressed: boolean;
  private readonly budget: Budget;
  private readonly cancellation = new AbortController();
  private readonly signal: AbortSignal;
  private input: Uint8Array | undefined;
  private inputOffset = 0;
  private releaseInput: (() => void) | undefined;
  private releaseRead: (() => void) | undefined;
  private reading: Promise<Uint8Array | undefined> | undefined;
  private writing: Promise<void> | undefined;

  constructor(stream: RpcStream, protocol: RelayRpcProtocol = "ndjson", budget = codecBudget) {
    this.stream = stream;
    this.compressed = protocol === compressedProtocol;
    this.budget = budget;
    this.signal = AbortSignal.any([stream.signal, this.cancellation.signal]);
    this.signal.addEventListener("abort", () => this.clearInput(), { once: true });
  }

  private reserve(bytes: number): () => void {
    const release = this.budget.reserve(bytes);
    requireRelay(release, "BUSY");
    return release;
  }

  private clearInput(): void {
    this.input = undefined;
    this.inputOffset = 0;
    this.releaseInput?.();
    this.releaseInput = undefined;
  }

  private async exact(length: number, allowEnd = false): Promise<Uint8Array | undefined> {
    const output = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      requireRelay(!this.signal.aborted, "INCOMPLETE");
      if (!this.input) {
        const bytes = await this.stream.read();
        requireRelay(!this.signal.aborted, "INCOMPLETE");
        if (!bytes) {
          requireRelay(allowEnd && offset === 0, "INCOMPLETE");
          return undefined;
        }
        requireRelay(bytes.byteLength > 0 && bytes.byteLength <= RELAY_LIMITS.dataBytes);
        // Idle readers hold no codec workspace. First delivery admits before
        // retaining a prefix or starting native decompression.
        this.releaseRead ??= this.reserve(workspaceBytes);
        this.releaseInput = this.reserve(RELAY_LIMITS.dataBytes);
        this.input = bytes;
      }
      this.releaseRead ??= this.reserve(workspaceBytes);
      const count = Math.min(length - offset, this.input.length - this.inputOffset);
      output.set(this.input.subarray(this.inputOffset, this.inputOffset + count), offset);
      this.inputOffset += count;
      offset += count;
      if (this.inputOffset === this.input.length) this.clearInput();
    }
    return output;
  }

  read(): Promise<Uint8Array | undefined> {
    requireRelay(!this.reading && !this.signal.aborted, "INCOMPLETE");
    const read = async () => {
      if (!this.compressed) return this.stream.read();
      const header = await this.exact(headerBytes, true);
      if (!header) return undefined;
      const view = new DataView(header.buffer, header.byteOffset, header.byteLength),
        kind = view.getUint8(0),
        raw = view.getUint32(1),
        encoded = view.getUint32(5);
      requireRelay(
        (kind === 0 || kind === 1) &&
          raw > 0 &&
          raw <= RELAY_RPC_RECORD_BYTES &&
          encoded > 0 &&
          encoded <= RELAY_RPC_RECORD_BYTES &&
          (kind === 0 ? raw === encoded : encoded < raw),
      );
      const body = (await this.exact(encoded))!;
      const output = kind === 0 ? body : await gzip(body, true, raw, this.signal);
      requireRelay(output.length === raw && !this.signal.aborted, "INCOMPLETE");
      return output;
    };
    const job = read()
      .catch((error: unknown) => {
        this.retire();
        throw error instanceof RelayError ? error : new RelayError("INCOMPLETE");
      })
      .finally(() => {
        this.releaseRead?.();
        this.releaseRead = undefined;
        this.reading = undefined;
      });
    this.reading = job;
    return job;
  }

  write(bytes: Uint8Array): Promise<void> {
    requireRelay(!this.writing && !this.signal.aborted, "INCOMPLETE");
    const write = async () => {
      const size = this.compressed ? RELAY_RPC_RECORD_BYTES : RELAY_DATA_CHUNK_BYTES;
      const release = this.compressed ? this.reserve(workspaceBytes) : undefined;
      const cell = this.compressed ? new Uint8Array(RELAY_DATA_CHUNK_BYTES) : undefined;
      let used = 0,
        records = 0;
      const flush = async () => {
        if (!cell || !used) return;
        requireRelay(!this.signal.aborted, "INCOMPLETE");
        await this.stream.write(cell.subarray(0, used));
        used = 0;
        records = 0;
      };
      try {
        for (let offset = 0; offset < bytes.length; offset += size) {
          requireRelay(!this.signal.aborted, "INCOMPLETE");
          const raw = bytes.subarray(offset, offset + size);
          if (!cell) {
            await this.stream.write(raw);
            continue;
          }
          const compressed =
            raw.length >= 1024 ? await gzip(raw, false, raw.length + 1024, this.signal) : undefined;
          const body = compressed && compressed.length + 32 < raw.length ? compressed : raw;
          const record = new Uint8Array(headerBytes + body.length),
            view = new DataView(record.buffer);
          view.setUint8(0, body === raw ? 0 : 1);
          view.setUint32(1, raw.length);
          view.setUint32(5, body.length);
          record.set(body, headerBytes);
          let start = 0;
          while (start < record.length) {
            const count = Math.min(cell.length - used, record.length - start);
            cell.set(record.subarray(start, start + count), used);
            used += count;
            start += count;
            if (used === cell.length) await flush();
          }
          // Pack within one RPC write, never wait for a later message. Bound
          // first-delivery work even when a very large message compresses well.
          if (++records === 4) await flush();
        }
        await flush();
        requireRelay(!this.signal.aborted, "INCOMPLETE");
      } finally {
        release?.();
      }
    };
    const job = write()
      .catch((error: unknown) => {
        this.retire();
        throw error instanceof RelayError ? error : new RelayError("INCOMPLETE");
      })
      .finally(() => {
        this.writing = undefined;
      });
    this.writing = job;
    return job;
  }

  finish(): Promise<void> {
    return this.stream.finish();
  }

  retire(): void {
    this.cancellation.abort();
    this.stream.retire();
  }

  async close(): Promise<void> {
    this.retire();
    await Promise.allSettled([this.reading, this.writing]);
  }
}
