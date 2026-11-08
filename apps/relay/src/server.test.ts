import { describe, expect, it, type TestContext } from "vitest";
import { startRelayServer, peerPrefix } from "./server.ts";
import { createIdentity, deriveIdentityId, sha256, signBytes } from "@cafecode/relay/crypto";
import { opaque, randomOpaque, unopaque, utf8 } from "@cafecode/relay/bytes";
import { signNetwork } from "@cafecode/relay/descriptor";
import { connectNative } from "@cafecode/relay/nativeWire";
import { RelayLeg, type EndpointCircuit } from "@cafecode/relay/leg";
import { relayResources, type PacketConnection } from "@cafecode/relay/wire";
import { admissionProof } from "@cafecode/relay/broker";
import { OUTER, ZERO_CIRCUIT } from "@cafecode/relay/protocol";
import { epochNow } from "@cafecode/relay/lifetime";
import { RelaySession, type SessionHandlers } from "@cafecode/relay/session";
import { RelayError } from "@cafecode/relay/errors";
import { fetchRelayed, serveRelayedHttp } from "@cafecode/relay/http";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as TestClock from "effect/testing/TestClock";
import type * as Clock from "effect/Clock";

async function fixture(test: TestContext, clock?: Clock.Clock, beforeClose: () => void = () => {}) {
  let retired = false;
  const held = new Set<PacketConnection>();
  let server: Awaited<ReturnType<typeof startRelayServer>> | undefined;
  const retire = () => {
    retired = true;
    beforeClose();
    for (const connection of held) connection.retire();
    void server?.close();
  };
  test.signal.addEventListener("abort", retire, { once: true });
  const close = async () => {
    retire();
    await Promise.all([...held].map((connection) => connection.close()));
    await server?.close();
  };
  test.onTestFinished(close);
  const [root, node, admission, host, viewer, viewerAdmission] = await Promise.all(
    Array.from({ length: 6 }, () => createIdentity()),
  );
  const identities = {
    root: root!,
    node: node!,
    admission: admission!,
    host: host!,
    viewer: viewer!,
    viewerAdmission: viewerAdmission!,
  };
  const nodeId = deriveIdentityId("node", identities.node.publicKey),
    locator = randomOpaque(),
    token = randomOpaque();
  const network = await signNetwork({
    root: identities.root,
    revision: 1,
    expiresAt: epochNow() + 3_600_000,
    nodes: [{ id: nodeId, publicKey: identities.node.publicKey, url: "ws://127.0.0.1:1/v1/relay" }],
  });
  if (retired) throw new Error("fixture-retired");
  server = await startRelayServer({
    network,
    nodeId,
    grants: [
      {
        locator,
        admissionPublicKey: identities.admission.publicKey,
        tokenDigest: opaque(sha256(unopaque(token, 32))),
      },
    ],
    host: "127.0.0.1",
    port: 0,
    allowLoopbackTest: true,
  });
  if (retired) {
    await server.close();
    throw new Error("fixture-retired");
  }
  const resources = relayResources(clock);
  const connect = () => {
    const connection = connectNative(`ws://127.0.0.1:${server!.port}/v1/relay`, resources);
    held.add(connection);
    if (retired) connection.retire();
    return new RelayLeg(connection, resources, network.networkId, nodeId);
  };
  return { ...identities, network, nodeId, locator, token, server, connect, resources, close };
}

async function sessions(
  test: TestContext,
  handlers: SessionHandlers,
  clock?: Clock.Clock,
  beforeClose: () => void = () => {},
) {
  const f = await fixture(test, clock, beforeClose),
    hostLeg = f.connect();
  const hostOffered = Promise.withResolvers<EndpointCircuit>();
  hostLeg.onOffer((id, offer) => {
    const circuit = hostLeg.circuit(id, offer, "host");
    circuit.accept();
    hostOffered.resolve(circuit);
  });
  const registration = await hostLeg.register(f.locator, f.token, f.admission);
  const ticket = (await hostLeg.mintTickets(registration.registrationId, "invite", null))
    .tickets[0]!;
  const viewerLeg = f.connect(),
    viewerOffered = Promise.withResolvers<EndpointCircuit>();
  viewerLeg.onOffer((id, offer) => viewerOffered.resolve(viewerLeg.circuit(id, offer, "viewer")));
  const hello = await viewerLeg.hello;
  const request = {
    locator: f.locator,
    registrationId: registration.registrationId,
    viewerCircuitNonce: randomOpaque(16),
    admissionPublicKey: f.viewerAdmission.publicKey,
    ticket: ticket.token,
    recovery: false,
  };
  viewerLeg.send(OUTER.ATTACH, ZERO_CIRCUIT, {
    ...request,
    signature: await signBytes(f.viewerAdmission, admissionProof(hello, request)),
  });
  const [hostCircuit, viewerCircuit] = await Promise.all([
    hostOffered.promise,
    viewerOffered.promise,
  ]);
  const [host, viewer] = await Promise.all([
    RelaySession.open({ circuit: hostCircuit, direction: "host", identity: f.host, handlers }),
    RelaySession.open({
      circuit: viewerCircuit,
      direction: "viewer",
      identity: f.viewer,
      expectedHostKey: f.host.publicKey,
    }),
  ]);
  test.onTestFinished(async () => {
    beforeClose();
    await host.close();
    await viewer.close();
  });
  return { ...f, host, viewer, hostConnection: hostLeg.connection };
}

describe("native single-hop relay", () => {
  it("carries real Noise over native sockets and releases exact circuit/socket owners", async (test) => {
    const f = await fixture(test),
      hostLeg = f.connect();
    const offered = Promise.withResolvers<EndpointCircuit>();
    hostLeg.onOffer((id, offer) => {
      const circuit = hostLeg.circuit(id, offer, "host");
      circuit.accept();
      offered.resolve(circuit);
    });
    const registration = await hostLeg.register(f.locator, f.token, f.admission);
    const ticket = (await hostLeg.mintTickets(registration.registrationId, "invite", null))
      .tickets[0]!;
    const viewerLeg = f.connect(),
      viewerOffered = Promise.withResolvers<EndpointCircuit>();
    viewerLeg.onOffer((id, offer) => viewerOffered.resolve(viewerLeg.circuit(id, offer, "viewer")));
    const hello = await viewerLeg.hello;
    const request = {
      locator: f.locator,
      registrationId: registration.registrationId,
      viewerCircuitNonce: randomOpaque(16),
      admissionPublicKey: f.viewerAdmission.publicKey,
      ticket: ticket.token,
      recovery: false,
    };
    viewerLeg.send(OUTER.ATTACH, ZERO_CIRCUIT, {
      ...request,
      signature: await signBytes(f.viewerAdmission, admissionProof(hello, request)),
    });
    const [hostCircuit, viewerCircuit] = await Promise.all([
      offered.promise,
      viewerOffered.promise,
    ]);
    const [host, viewer] = await Promise.all([
      hostCircuit.secure(f.host),
      viewerCircuit.secure(f.viewer, f.host.publicKey),
    ]);
    expect(host.remotePublicKey).toBe(f.viewer.publicKey);
    expect(viewer.remotePublicKey).toBe(f.host.publicKey);
    const received = Promise.withResolvers<Uint8Array>();
    host.stream.addEventListener(
      "message",
      (event) => {
        const bytes = event.data.subarray();
        hostCircuit.consumedPlaintext(bytes.byteLength);
        received.resolve(bytes);
      },
      { once: true },
    );
    viewer.stream.send(utf8.encode("native-ciphertext-only-canary"));
    expect(await received.promise).toEqual(utf8.encode("native-ciphertext-only-canary"));
    hostCircuit.authorize();
    expect(f.server.stats().circuits).toBe(1);
    viewerCircuit.retire();
    await viewerLeg.connection.close();
    await hostLeg.connection.close();
    await f.server.close();
    expect(f.server.stats()).toMatchObject({
      owners: 0,
      nativeSockets: 0,
      pendingBytes: 0,
      circuits: 0,
      registrations: 0,
    });
    expect(f.resources.owners.current).toBe(0);
    expect(f.resources.pending.current).toBe(0);
  });
  it("groups IPv6 aliases by /64 and never consumes forwarded peer claims", () => {
    expect(peerPrefix("2001:0db8:0:0:1:2:3:4")).toBe(peerPrefix("2001:db8::abcd"));
    expect(peerPrefix("::ffff:192.0.2.2")).toBe(peerPrefix("192.0.2.2"));
    expect(peerPrefix("2001:db8:0:1::1")).not.toBe(peerPrefix("2001:db8::1"));
    expect(() => peerPrefix(undefined)).toThrow();
  });

  it("binds the device, preserves explicit second-factor retry, and streams complete files", async (test) => {
    const secret = randomOpaque(),
      accepted = Promise.withResolvers<void>();
    let authCalls = 0,
      admittedDevice = "";
    const payload = new Uint8Array(102_403).map((_, index) => index % 251);
    const f = await sessions(test, {
      authenticate: async (input, device) => {
        authCalls++;
        admittedDevice = device;
        if (!input.secondFactor) throw new RelayError("SECOND_FACTOR_REQUIRED");
        if (
          input.credential !== secret ||
          input.secondFactor !== "123456" ||
          input.environmentId !== "synthetic-environment"
        )
          throw new RelayError("AUTH_REJECTED");
        return {
          environmentId: input.environmentId,
          bearerToken: "synthetic-session-canary",
          role: "client",
          expiresAt: epochNow() + 60_000,
        };
      },
      open: async (stream, metadata) => {
        expect(metadata).toEqual({ path: "/synthetic-file" });
        expect(await stream.read()).toBeUndefined();
        await stream.accept({ status: 200, length: payload.byteLength });
        accepted.resolve();
        for (let index = 0; index < payload.byteLength; index += 8192)
          await stream.write(payload.subarray(index, index + 8192));
        await stream.finish();
      },
    });
    await expect(
      f.viewer.authenticate({
        environmentId: "synthetic-environment",
        operation: "pair",
        credential: secret,
      }),
    ).rejects.toMatchObject({ code: "SECOND_FACTOR_REQUIRED" });
    expect(authCalls).toBe(1);
    const auth = await f.viewer.authenticate({
      environmentId: "synthetic-environment",
      operation: "pair",
      credential: secret,
      secondFactor: "123456",
    });
    expect(auth.bearerToken).toBe("synthetic-session-canary");
    expect(admittedDevice).toBe(
      f.viewer.remotePublicKey === f.host.remotePublicKey ? "invalid" : f.host.remotePublicKey,
    );
    const stream = await f.viewer.open("http", { path: "/synthetic-file" });
    await stream.finish();
    await accepted.promise;
    expect(await stream.metadata).toEqual({ status: 200, length: payload.byteLength });
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const chunk = await stream.read();
      if (!chunk) break;
      chunks.push(chunk);
      length += chunk.byteLength;
    }
    const actual = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      actual.set(chunk, offset);
      offset += chunk.byteLength;
    }
    expect(sha256(actual)).toEqual(sha256(payload));
    expect(length).toBe(payload.byteLength);
    expect(authCalls).toBe(2);
    await f.viewer.close();
    await f.host.close();
  });

  it("reports a missing authenticated FIN as incomplete", async (test) => {
    const written = Promise.withResolvers<void>();
    const f = await sessions(test, {
      authenticate: async (input) => ({
        environmentId: input.environmentId,
        bearerToken: "synthetic-bearer",
        role: "client",
        expiresAt: epochNow() + 60_000,
      }),
      open: async (stream) => {
        await stream.accept({ status: 200 });
        await stream.write(utf8.encode("partial"));
        written.resolve();
      },
    });
    await f.viewer.authenticate({
      environmentId: "synthetic-environment",
      operation: "pair",
      credential: randomOpaque(),
    });
    const stream = await f.viewer.open("http", {});
    await stream.finish();
    await written.promise;
    expect(await stream.read()).toEqual(utf8.encode("partial"));
    const finalRead = stream.read();
    await f.host.close();
    await expect(finalRead).rejects.toMatchObject({ code: "INCOMPLETE" });
  });
  it("streams a complete bounded HTTP upload and download with native pacing", async (test) => {
    const f = await sessions(test, {
      authenticate: async (input) => ({
        environmentId: input.environmentId,
        bearerToken: "synthetic-http-bearer",
        role: "client",
        expiresAt: epochNow() + 60_000,
      }),
      open: async (stream, metadata) =>
        serveRelayedHttp(
          stream,
          metadata,
          async (request) =>
            new Response(request.body, {
              status: 200,
              headers: {
                "content-type": "application/octet-stream",
                "content-length": request.headers.get("content-length")!,
              },
            }),
        ),
    });
    await f.viewer.authenticate({
      environmentId: "synthetic-environment",
      operation: "pair",
      credential: randomOpaque(),
    });
    const bytes = new Uint8Array(1_048_597).map((_, index) => index % 251);
    const response = await fetchRelayed(f.viewer, "/api/attachments", {
      method: "POST",
      body: new Blob([bytes]),
      headers: { "content-type": "application/octet-stream" },
    });
    expect(response.status).toBe(200);
    const received = new Uint8Array(await response.arrayBuffer());
    expect(received.byteLength).toBe(bytes.byteLength);
    expect(sha256(received)).toEqual(sha256(bytes));
    expect(f.server.stats().circuits).toBe(1);
  });

  it("bounds cancelled-but-draining handlers while an admitted stream still makes progress", async (test) => {
    const gate = Promise.withResolvers<void>();
    let held = 0;
    const f = await sessions(
      test,
      {
        authenticate: async (input) => ({
          environmentId: input.environmentId,
          bearerToken: "synthetic-handler-capacity",
          role: "client",
          expiresAt: epochNow() + 60_000,
        }),
        open: async (stream, metadata) => {
          await stream.accept({});
          if (metadata === "held") {
            held++;
            await gate.promise;
            return;
          }
          for (;;) {
            const bytes = await stream.read();
            if (!bytes) break;
            await stream.write(bytes);
          }
          await stream.finish();
        },
      },
      undefined,
      () => gate.resolve(),
    );
    await f.viewer.authenticate({
      environmentId: "synthetic-environment",
      operation: "pair",
      credential: randomOpaque(),
    });
    const good = await f.viewer.open("rpc", "healthy");
    await good.metadata;
    for (let i = 0; i < 15; i++) {
      const stream = await f.viewer.open("rpc", "held");
      await stream.metadata;
      stream.retire();
    }
    const excess = await f.viewer.open("rpc", "held");
    await expect(excess.metadata).rejects.toMatchObject({ code: "INCOMPLETE" });
    expect(held).toBe(15);
    await good.write(utf8.encode("healthy-admitted-canary"));
    expect(await good.read()).toEqual(utf8.encode("healthy-admitted-canary"));
    expect(f.host.active).toBe(true);
    expect(f.viewer.active).toBe(true);
    gate.resolve();
  });

  it("retains bulk admission through cancelled HTTP handlers while RPC still progresses", async (test) => {
    const gate = Promise.withResolvers<void>();
    let bulk = 0;
    const f = await sessions(
      test,
      {
        authenticate: async (input) => ({
          environmentId: input.environmentId,
          bearerToken: "synthetic-bulk-capacity",
          role: "client",
          expiresAt: epochNow() + 60_000,
        }),
        open: async (stream) => {
          await stream.accept({});
          if (stream.kind === "http") {
            bulk++;
            await gate.promise;
            return;
          }
          for (;;) {
            const bytes = await stream.read();
            if (!bytes) break;
            await stream.write(bytes);
          }
          await stream.finish();
        },
      },
      undefined,
      () => gate.resolve(),
    );
    await f.viewer.authenticate({
      environmentId: "synthetic-environment",
      operation: "pair",
      credential: randomOpaque(),
    });
    const good = await f.viewer.open("rpc", {});
    await good.metadata;
    for (let i = 0; i < 2; i++) {
      const stream = await f.viewer.open("http", {});
      await stream.metadata;
      stream.retire();
    }
    const excess = await f.viewer.open("http", {});
    await expect(excess.metadata).rejects.toMatchObject({ code: "INCOMPLETE" });
    expect(bulk).toBe(2);
    await good.write(utf8.encode("healthy-rpc-canary"));
    expect(await good.read()).toEqual(utf8.encode("healthy-rpc-canary"));
    expect(f.host.active).toBe(true);
    gate.resolve();
  });

  it("joins an admitted application handler after transport retirement before releasing its owner", async (test) => {
    const gate = Promise.withResolvers<void>(),
      entered = Promise.withResolvers<void>();
    let nativeFinished = false;
    const f = await sessions(
      test,
      {
        authenticate: async (input) => ({
          environmentId: input.environmentId,
          bearerToken: "synthetic-held-handler",
          role: "client",
          expiresAt: epochNow() + 60_000,
        }),
        open: async (stream) => {
          await stream.accept({});
          entered.resolve();
          await gate.promise;
          nativeFinished = true;
        },
      },
      undefined,
      () => gate.resolve(),
    );
    await f.viewer.authenticate({
      environmentId: "synthetic-environment",
      operation: "pair",
      credential: randomOpaque(),
    });
    const stream = await f.viewer.open("rpc", {});
    await stream.metadata;
    await entered.promise;
    const closing = f.host.close().then(() => {
      expect(nativeFinished).toBe(true);
    });
    void closing.catch(() => {});
    await f.hostConnection.close();
    expect(nativeFinished).toBe(false);
    gate.resolve();
    await closing;
  });

  it("retires an incomplete Noise record at its original deadline despite credit traffic", async (test) => {
    const clockScope = Effect.runSync(Scope.make());
    let f: Awaited<ReturnType<typeof sessions>> | undefined;
    test.onTestFinished(async () => {
      await f?.close();
      await Effect.runPromise(Scope.close(clockScope, Exit.void));
    });
    const clock = await Effect.runPromise(Scope.provide(TestClock.make(), clockScope));
    const scopedClock: Clock.Clock = {
      ...clock,
      sleep: (duration) => Scope.provide(clock.sleep(duration), clockScope),
    };
    f = await sessions(
      test,
      {
        authenticate: async (input) => ({
          environmentId: input.environmentId,
          bearerToken: "synthetic-partial-bearer",
          role: "client",
          expiresAt: epochNow() + 60_000,
        }),
      },
      scopedClock,
    );
    await f.viewer.authenticate({
      environmentId: "synthetic-environment",
      operation: "pair",
      credential: randomOpaque(),
    });
    // The pending small AUTH credit window will publish while this record is
    // incomplete. That unrelated control must not cancel/refresh its deadline.
    f.viewer.circuit.raw.send(new Uint8Array([0, 100, 1]));
    await expect.poll(() => f!.host.circuit.raw.pendingRecordBytes).toBe(102);
    await Effect.runPromise(Scope.provide(clock.adjust("9999 millis"), clockScope));
    expect(f.host.active).toBe(true);
    await Effect.runPromise(Scope.provide(clock.adjust("1 millis"), clockScope));
    await f.host.closed;
    expect(f.host.active).toBe(false);
    expect(f.server.stats().registrations).toBe(1);
  });
});
