import { deepStrictEqual } from "node:assert";
import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { expect, it, type TestContext } from "vitest";
import * as Effect from "effect/Effect";
import { Budget } from "./budget.ts";
import { RelayError } from "./errors.ts";
import { RELAY_DATA_CHUNK_BYTES } from "./limits.ts";
import {
  RelayRpcTransport,
  RELAY_RPC_RECORD_BYTES,
  RELAY_RPC_COMPRESSION_HEADER,
  relayRpcHeaders,
  relayRpcProtocol,
  readRelayRpcProtocol,
  type RelayRpcProtocol,
} from "./rpc.ts";

function ownStream(context: TestContext, input: Uint8Array[] = [], end = true) {
  const cancellation = new AbortController(),
    budget = new Budget(2 * 1024 * 1024),
    chunks: Uint8Array[] = [];
  let reader: ((value: undefined) => void) | undefined;
  let waiting!: () => void;
  const readWaiting = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  const transports: RelayRpcTransport[] = [];
  const retire = () => {
    cancellation.abort();
    reader?.(undefined);
  };
  context.signal.addEventListener("abort", retire, { once: true });
  context.onTestFinished(async () => {
    retire();
    await Promise.all(transports.map((transport) => transport.close()));
    context.signal.removeEventListener("abort", retire);
    expect(budget.current).toBe(0);
  });
  const stream = {
    signal: cancellation.signal,
    read: async () => {
      if (cancellation.signal.aborted) throw new RelayError("INCOMPLETE");
      if (input.length) return input.shift();
      if (end) return undefined;
      return new Promise<undefined>((resolve) => {
        reader = resolve;
        waiting();
      });
    },
    write: async (bytes: Uint8Array) => {
      if (cancellation.signal.aborted) throw new RelayError("INCOMPLETE");
      chunks.push(bytes.slice());
    },
    finish: async () => {},
    retire,
  };
  return {
    chunks,
    budget,
    retire,
    readWaiting,
    transport: (protocol: RelayRpcProtocol, retained = budget) => {
      const transport = new RelayRpcTransport(stream, protocol, retained);
      transports.push(transport);
      return transport;
    },
  };
}

function record(kind: number, raw: number, body: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(9 + body.length),
    view = new DataView(bytes.buffer);
  view.setUint8(0, kind);
  view.setUint32(1, raw);
  view.setUint32(5, body.length);
  bytes.set(body, 9);
  return bytes;
}

const protocol = relayRpcProtocol(relayRpcHeaders());

it("negotiates compression only after an exact offer and acknowledgement, with same-stream legacy fallback", () => {
  expect(protocol).toBe("ndjson-gzip-records-v1");
  expect(relayRpcProtocol([])).toBe("ndjson");
  expect(relayRpcProtocol([[RELAY_RPC_COMPRESSION_HEADER, "future-version"]])).toBe("ndjson");
  expect(relayRpcProtocol([...relayRpcHeaders(), ...relayRpcHeaders()])).toBe("ndjson");
  expect(readRelayRpcProtocol({ protocol: "ndjson" }, relayRpcHeaders())).toBe("ndjson");
  expect(readRelayRpcProtocol({ protocol }, relayRpcHeaders())).toBe(protocol);
  for (const metadata of [null, {}, { protocol: "unknown" }, { protocol, extra: true }])
    expect(() => readRelayRpcProtocol(metadata, relayRpcHeaders())).toThrow();
  expect(() => readRelayRpcProtocol({ protocol }, [])).toThrow();
});

it.for(["compressible", "incompressible"])(
  "round trips %s bytes with bounded records, preserving UTF-8 and incompressible fallback",
  async (kind, context) => {
    const started = performance.now();
    const elapsed = () => Math.min(60_000, Math.max(0, Math.round(performance.now() - started)));
    let phase = "input";
    const completed = {
      encodedMs: null as number | null,
      decodedMs: null as number | null,
      comparedMs: null as number | null,
    };
    const observe = () => ({
      kind,
      phase,
      elapsedMs: elapsed(),
      ...completed,
    });
    let failure: ReturnType<typeof observe> | undefined;
    // Freeze the last actual phase before timeout cleanup can resume an
    // interrupted stream. Diagnostics contain no payloads or native errors.
    const retire = () => {
      failure ??= observe();
    };
    context.signal.addEventListener("abort", retire, { once: true });
    context.onTestFailed(() => {
      try {
        Effect.runSync(Effect.logError("Relay RPC round-trip phases", failure ?? observe()));
      } catch {
        // Passive metadata cannot replace the original test failure.
      }
    });
    context.onTestFinished(() => context.signal.removeEventListener("abort", retire));
    const bytes =
      kind === "compressible"
        ? new TextEncoder().encode(JSON.stringify({ text: "café ☕ 🌐\n".repeat(20_000) }) + "\n")
        : new Uint8Array(randomBytes(RELAY_RPC_RECORD_BYTES * 3 + 127));
    const sender = ownStream(context);
    phase = "encode";
    await sender.transport(protocol).write(bytes);
    completed.encodedMs = elapsed();
    expect(sender.chunks.every((chunk) => chunk.length <= RELAY_DATA_CHUNK_BYTES)).toBe(true);
    const wireBytes = sender.chunks.reduce((total, chunk) => total + chunk.length, 0);
    if (kind === "compressible") expect(wireBytes).toBeLessThan(bytes.length / 20);
    else expect(wireBytes).toBeLessThan(bytes.length + 100);
    const receiver = ownStream(context, sender.chunks.slice()),
      decoded = receiver.transport(protocol);
    const output = new Uint8Array(bytes.length);
    let offset = 0;
    phase = "decode";
    for (;;) {
      const chunk = await decoded.read();
      if (!chunk) break;
      expect(chunk.length).toBeLessThanOrEqual(RELAY_RPC_RECORD_BYTES);
      output.set(chunk, offset);
      offset += chunk.length;
    }
    expect(offset).toBe(bytes.length);
    completed.decodedMs = elapsed();
    phase = "compare";
    // Native typed-array equality checks every byte without creating and then
    // recursively comparing a property-entry array for this large payload.
    deepStrictEqual(output, bytes);
    completed.comparedMs = elapsed();
    phase = "budgets";
    expect(sender.budget.current).toBe(0);
    expect(receiver.budget.current).toBe(0);
    phase = "complete";
  },
);

it("delivers small interactive writes immediately and decodes fragmented or coalesced records", async (context) => {
  const first = new TextEncoder().encode('{"ping":1}\n'),
    second = new TextEncoder().encode('{"pong":2}\n');
  const sender = ownStream(context),
    writer = sender.transport(protocol);
  await writer.write(first);
  expect(sender.chunks.length).toBe(1);
  await writer.write(second);
  const joined = new Uint8Array(sender.chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of sender.chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  for (const input of [[joined], Array.from(joined, (byte) => new Uint8Array([byte]))]) {
    const receiver = ownStream(context, input),
      reader = receiver.transport(protocol);
    expect(await reader.read()).toEqual(first);
    expect(await reader.read()).toEqual(second);
    expect(await reader.read()).toBeUndefined();
    expect(receiver.budget.current).toBe(0);
  }
});

it.for([
  ["unknown kind", () => record(2, 1, new Uint8Array([1]))],
  ["raw length mismatch", () => record(0, 2, new Uint8Array([1]))],
  ["oversize output", () => record(1, RELAY_RPC_RECORD_BYTES + 1, new Uint8Array([1]))],
  [
    "oversize input",
    () =>
      record(1, RELAY_RPC_RECORD_BYTES, new Uint8Array(RELAY_RPC_RECORD_BYTES + 1)).subarray(0, 9),
  ],
  ["truncated header", () => new Uint8Array([1, 0, 0])],
  ["truncated body", () => record(0, 3, new Uint8Array([1, 2, 3])).subarray(0, 11)],
  ["invalid gzip", () => record(1, 100, new Uint8Array([1, 2, 3]))],
  [
    "expansion beyond declaration",
    () => record(1, 1024, gzipSync(new Uint8Array(RELAY_RPC_RECORD_BYTES * 4))),
  ],
  ["short output", () => record(1, 4096, gzipSync(new Uint8Array(1024)))],
  [
    "bad checksum",
    () => {
      const bytes = gzipSync(new Uint8Array(1024));
      bytes[bytes.length - 8]! ^= 1;
      return record(1, 1024, bytes);
    },
  ],
] as const)(
  "rejects %s before delivering partial application data and releases its workspace",
  async ([_label, input], context) => {
    const owned = ownStream(context, [input()]),
      transport = owned.transport(protocol);
    await expect(transport.read()).rejects.toBeInstanceOf(RelayError);
    expect(owned.budget.current).toBe(0);
  },
);

it("keeps idle readers free, cancels exact partial reads and refuses codec work when the bounded budget is held", async (context) => {
  const idle = ownStream(context, [], false),
    reader = idle.transport(protocol);
  const pending = reader.read();
  expect(idle.budget.current).toBe(0);
  idle.retire();
  await expect(pending).rejects.toBeInstanceOf(RelayError);
  await reader.close();
  const partial = ownStream(context, [new Uint8Array([1])], false),
    partialReader = partial.transport(protocol);
  const reading = partialReader.read();
  await partial.readWaiting;
  expect(partial.budget.current).toBeGreaterThan(0);
  partial.retire();
  await expect(reading).rejects.toBeInstanceOf(RelayError);
  await partialReader.close();
  const unavailable = ownStream(context),
    budget = new Budget(1),
    writer = unavailable.transport(protocol, budget);
  await expect(writer.write(new Uint8Array(1024))).rejects.toMatchObject({ code: "BUSY" });
  expect(unavailable.chunks.length).toBe(0);
  expect(budget.current).toBe(0);
});

it("cancels and joins a native compression already admitted by the exact writer", async (context) => {
  const owned = ownStream(context),
    transport = owned.transport(protocol);
  const writing = transport.write(new Uint8Array(RELAY_RPC_RECORD_BYTES));
  expect(owned.budget.current).toBeGreaterThan(0);
  owned.retire();
  await expect(writing).rejects.toBeInstanceOf(RelayError);
  await transport.close();
  expect(owned.budget.current).toBe(0);
  expect(owned.chunks).toEqual([]);
});

it("passes legacy NDJSON unchanged without codec admission", async (context) => {
  const bytes = new TextEncoder().encode('{"plain":true}\n'),
    owned = ownStream(context, [bytes]);
  const transport = owned.transport("ndjson", new Budget(1));
  await transport.write(bytes);
  expect(owned.chunks).toEqual([bytes]);
  expect(await transport.read()).toEqual(bytes);
  expect(await transport.read()).toBeUndefined();
});
