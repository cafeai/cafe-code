import { describe, expect, it, type TestContext } from "vitest";
import {
  type RelayIdentity,
  createIdentity,
  deriveIdentityId,
  NOISE_LOGGER,
  privateIdentityBytes,
  RELAY_UPGRADER,
  restoreIdentity,
  secureChannel,
} from "./crypto.ts";
import { RelayNoiseStream, NoiseRecordGuard, type CircuitWire } from "./noiseStream.ts";
import { randomOpaque, utf8, concatenate } from "./bytes.ts";
import { Budget } from "./budget.ts";
import { RelayError } from "./errors.ts";

function fixture(test: TestContext, fragmentBytes = 7) {
  const controller = new AbortController();
  const observed: Uint8Array[] = [];
  let retired = false;
  let viewer: RelayNoiseStream;
  let host: RelayNoiseStream;
  const queues = new Map<"viewer" | "host", Array<{ bytes: Uint8Array; release: () => void }>>([
    ["viewer", []],
    ["host", []],
  ]);
  let relayFault = (_source: "viewer" | "host", bytes: Uint8Array): Uint8Array => bytes;
  const paused = new Set<"viewer" | "host">();
  const budget = new Budget(262_144);
  const close = () => {
    if (retired) return;
    retired = true;
    controller.abort();
    for (const queue of queues.values()) for (const entry of queue.splice(0)) entry.release();
    viewer?.onTransportClosed();
    host?.onTransportClosed();
  };
  // Retirement is installed before key generation or any handshake acquisition.
  test.signal.addEventListener("abort", close, { once: true });
  test.onTestFinished(async () => {
    close();
    await Promise.resolve();
  });
  const flush = (target: "viewer" | "host") => {
    if (retired || paused.has(target)) return;
    const queue = queues.get(target)!;
    for (const entry of queue.splice(0)) {
      entry.release();
      (target === "viewer" ? viewer : host).receive(entry.bytes);
    }
    (target === "viewer" ? host : viewer).onMuxerDrain();
  };
  const wire = (source: "viewer" | "host"): CircuitWire => ({
    write(bytes) {
      if (retired) throw new RelayError("UNAVAILABLE");
      const target = source === "viewer" ? "host" : "viewer";
      const forwarded = relayFault(source, bytes.slice());
      if (!forwarded.byteLength) return { sentBytes: bytes.byteLength, canSendMore: true };
      const release = budget.reserve(forwarded.byteLength);
      if (!release) return { sentBytes: 0, canSendMore: false };
      observed.push(forwarded.slice());
      // The fixture owns every queued fragment until its exact delivery/close.
      const copy = forwarded;
      queues.get(target)!.push({ bytes: copy, release });
      queueMicrotask(() => {
        if (retired || paused.has(target)) return;
        const entry = queues.get(target)!.shift();
        if (!entry) return;
        entry.release();
        for (let i = 0; i < entry.bytes.length; i += fragmentBytes) {
          (target === "viewer" ? viewer : host).receive(entry.bytes.subarray(i, i + fragmentBytes));
        }
        (source === "viewer" ? viewer : host).onMuxerDrain();
      });
      return { sentBytes: bytes.byteLength, canSendMore: budget.available > 65_536 };
    },
    reset: close,
    pause: () => {
      paused.add(source);
    },
    resume: () => {
      paused.delete(source);
      flush(source);
    },
    close: async () => {
      close();
    },
  });
  viewer = new RelayNoiseStream("viewer", wire("viewer"));
  host = new RelayNoiseStream("host", wire("host"));
  return {
    viewer,
    host,
    observed,
    controller,
    close,
    budget,
    fault: (mutate: typeof relayFault) => {
      relayFault = mutate;
    },
  };
}

function context() {
  return {
    networkId: randomOpaque(),
    locator: randomOpaque(),
    registrationId: randomOpaque(16),
    viewerCircuitNonce: randomOpaque(16),
  };
}

async function connect(test: TestContext, expected?: RelayIdentity) {
  const f = fixture(test);
  const [viewerIdentity, hostIdentity] = await Promise.all([createIdentity(), createIdentity()]);
  const binding = context();
  const result = await Promise.all([
    secureChannel({
      identity: viewerIdentity,
      stream: f.viewer,
      context: binding,
      direction: "viewer",
      expectedHostKey: (expected ?? hostIdentity).publicKey,
      signal: f.controller.signal,
    }),
    secureChannel({
      identity: hostIdentity,
      stream: f.host,
      context: binding,
      direction: "host",
      signal: f.controller.signal,
    }),
  ]);
  return { f, result, viewerIdentity, hostIdentity };
}

describe("actual public Noise adapter", () => {
  it("pins both identities and carries encrypted data across fragmented records", async (test) => {
    const { f, result, viewerIdentity, hostIdentity } = await connect(test);
    const [viewer, host] = result;
    expect(viewer.remotePublicKey).toBe(hostIdentity.publicKey);
    expect(host.remotePublicKey).toBe(viewerIdentity.publicKey);
    const text = "synthetic-private-cafe-payload-canary";
    const received = new Promise<Uint8Array>((resolve) => {
      host.stream.addEventListener("message", (event) => resolve(event.data.subarray()), {
        once: true,
      });
    });
    viewer.stream.send(utf8.encode(text));
    expect(await received).toEqual(utf8.encode(text));
    expect(f.observed.every((bytes) => !new TextDecoder().decode(bytes).includes(text))).toBe(true);
    f.close();
  });

  it("refuses a substituted host before any application data", async (test) => {
    const f = fixture(test);
    const [viewerIdentity, hostIdentity, wrong] = await Promise.all([
      createIdentity(),
      createIdentity(),
      createIdentity(),
    ]);
    const binding = context();
    const results = await Promise.allSettled([
      secureChannel({
        identity: viewerIdentity,
        stream: f.viewer,
        context: binding,
        direction: "viewer",
        expectedHostKey: wrong.publicKey,
        signal: f.controller.signal,
      }),
      secureChannel({
        identity: hostIdentity,
        stream: f.host,
        context: binding,
        direction: "host",
        signal: f.controller.signal,
      }),
    ]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    const viewerFailure = results[0];
    expect(
      viewerFailure?.status === "rejected" &&
        viewerFailure.reason instanceof RelayError &&
        viewerFailure.reason.code,
    ).toBe("HOST_IDENTITY_MISMATCH");
  });

  it("refuses a different network/prologue without an authentication fallback", async (test) => {
    const f = fixture(test);
    const [viewerIdentity, hostIdentity] = await Promise.all([createIdentity(), createIdentity()]);
    const binding = context();
    const results = await Promise.allSettled([
      secureChannel({
        identity: viewerIdentity,
        stream: f.viewer,
        context: binding,
        direction: "viewer",
        expectedHostKey: hostIdentity.publicKey,
        signal: f.controller.signal,
      }),
      secureChannel({
        identity: hostIdentity,
        stream: f.host,
        context: { ...binding, networkId: randomOpaque() },
        direction: "host",
        signal: f.controller.signal,
      }),
    ]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
  });

  for (const mode of ["tamper", "replay", "lost-record"] as const)
    it(
      mode + ": retires the encrypted channel without accepting forged/repeated application data",
      async (test) => {
        const {
          f,
          result: [viewer, host],
        } = await connect(test);
        let messages = 0,
          forwarded = 0;
        const closed = new Promise<void>((resolve) =>
          host.stream.addEventListener("close", () => resolve(), { once: true }),
        );
        host.stream.addEventListener("message", () => messages++);
        f.fault((source, bytes) => {
          if (source !== "viewer") return bytes;
          forwarded++;
          if (mode === "replay") return concatenate(bytes, bytes);
          if (mode === "lost-record") return forwarded === 1 ? new Uint8Array() : bytes;
          const changed = bytes.slice();
          changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
          return changed;
        });
        viewer.stream.send(utf8.encode("synthetic-fault-canary-one"));
        if (mode === "lost-record") viewer.stream.send(utf8.encode("synthetic-fault-canary-two"));
        await closed;
        expect(messages).toBe(mode === "replay" ? 1 : 0);
        f.close();
        expect(f.budget.current).toBe(0);
      },
    );

  it("restores only Ed25519 identity and separates operator/relay domains", async () => {
    const original = await createIdentity();
    const restored = restoreIdentity(privateIdentityBytes(original));
    expect(restored.publicKey).toBe(original.publicKey);
    expect(deriveIdentityId("network", original.publicKey)).not.toBe(
      deriveIdentityId("node", original.publicKey),
    );
    expect(() => restoreIdentity(new Uint8Array(129))).toThrow();
  });

  it("keeps every logger scope closed and denies raw libp2p upgrades", () => {
    expect(NOISE_LOGGER.enabled).toBe(false);
    expect(NOISE_LOGGER.newScope("secret-session")).toBe(NOISE_LOGGER);
    expect(Object.isFrozen(NOISE_LOGGER)).toBe(true);
    expect(RELAY_UPGRADER.getStreamMuxers().size).toBe(0);
    expect(RELAY_UPGRADER.getConnectionEncrypters().size).toBe(0);
    expect(() => RELAY_UPGRADER.createInboundAbortSignal(new AbortController().signal)).toThrow();
  });
});

describe("Noise record admission before library decoding", () => {
  it("rejects an oversized handshake before allocating the record", () => {
    const guard = new NoiseRecordGuard("host");
    expect(() => guard.push(new Uint8Array([0x10, 0x01]), () => {})).toThrow();
    expect(guard.pendingBytes).toBe(2);
    guard.retire();
    expect(() => guard.push(new Uint8Array([1]), () => {})).toThrow();
  });
});
