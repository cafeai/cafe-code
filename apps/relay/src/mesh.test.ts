import { describe, expect, it, type TestContext } from "vitest";
import * as Effect from "effect/Effect";
import { startRelayServer } from "./server.ts";
import { createIdentity, deriveIdentityId, sha256 } from "@cafecode/relay/crypto";
import { canonicalBytes } from "@cafecode/relay/protocol";
import { opaque, randomOpaque, unopaque, utf8 } from "@cafecode/relay/bytes";
import { signNetwork } from "@cafecode/relay/descriptor";
import { RelayHost } from "@cafecode/relay/host";
import { NativeHostWorkClient } from "@cafecode/relay/nativeHostWork";
import { connectViewer } from "@cafecode/relay/client";
import { connectNative } from "@cafecode/relay/nativeWire";
import { RelayError } from "@cafecode/relay/errors";
import { epochNow, Lifetime, monotonicMillis } from "@cafecode/relay/lifetime";

type MeshPhase =
  | "identities"
  | "network-first"
  | "listen-first"
  | "network-second"
  | "update-first"
  | "listen-second"
  | "network-third"
  | "update-second"
  | "listen-third"
  | "membership"
  | "host-start"
  | "mesh-sync"
  | "invitation"
  | "viewer-connect"
  | "pair-auth"
  | "open-before"
  | "metadata-before"
  | "write-before"
  | "read-before"
  | "first-close"
  | "viewer-closed"
  | "resume-connect"
  | "resume-auth"
  | "open-after"
  | "metadata-after"
  | "write-after"
  | "read-after"
  | "foreign-identity"
  | "foreign-network"
  | "foreign-refusal"
  | "resumed-close"
  | "host-close"
  | "second-close"
  | "third-close";

function owner(test: TestContext) {
  const lifetime = new Lifetime(),
    work = new NativeHostWorkClient(),
    servers: Array<Awaited<ReturnType<typeof startRelayServer>>> = [],
    viewers: Array<Awaited<ReturnType<typeof connectViewer>>> = [],
    pending = new Set<Promise<unknown>>(),
    closers = new Set<() => Promise<void>>(),
    hosts = new Set<RelayHost>();
  let retired = false,
    phase: MeshPhase = "identities",
    phaseStartedAt = monotonicMillis();
  const startedAt = phaseStartedAt;
  const elapsed = (since: number) =>
    Math.min(60_000, Math.max(0, Math.round(monotonicMillis() - since)));
  const observe = () => ({
    phase,
    elapsedMs: elapsed(startedAt),
    phaseElapsedMs: elapsed(phaseStartedAt),
    acquiredServers: Math.min(3, servers.length),
    acquiredViewers: Math.min(2, viewers.length),
    pendingOperations: Math.min(16, pending.size),
  });
  let failure: ReturnType<typeof observe> | undefined;
  const freezeFailure = () => {
    failure ??= observe();
  };
  const assertActive = () => {
    if (retired || test.signal.aborted) throw new RelayError("UNAVAILABLE");
  };
  // Retain each original operation before its first await. The post-await
  // fence prevents a timed-out body from admitting its next native operation.
  const hold = <A>(operation: Promise<A>): Promise<A> => {
    pending.add(operation);
    void operation.then(
      () => pending.delete(operation),
      () => pending.delete(operation),
    );
    return operation;
  };
  const run = async <A>(next: MeshPhase, start: () => Promise<A>): Promise<A> => {
    assertActive();
    phase = next;
    phaseStartedAt = monotonicMillis();
    const value = await hold(start());
    assertActive();
    return value;
  };
  // Publish one shared close promise before invoking native retirement. Both
  // public cancellation and normal completion join this same exact close;
  // handling its rejection here does not erase the joined cleanup failure.
  const holdClose = (close: () => Promise<void>) => {
    let closing: Promise<void> | undefined;
    const joined = () => {
      if (!closing) {
        const completion = Promise.withResolvers<void>();
        closing = completion.promise;
        void closing.catch(() => {});
        try {
          void close().then(completion.resolve, completion.reject);
        } catch (error) {
          completion.reject(error);
        }
      }
      return closing;
    };
    closers.add(joined);
    return joined;
  };
  holdClose(() => lifetime.close());
  holdClose(() => work.close());
  // Adoption belongs inside the held acquisition, before the body's await
  // continuation. A listener/viewer arriving after retirement is closed there,
  // and the cleanup hook cannot finish before that late native owner is joined.
  const acquire = <A extends { close: () => Promise<void> }>(
    next: MeshPhase,
    start: () => Promise<A>,
    retain: (value: A) => void,
  ): Promise<A> =>
    run(next, () => {
      const original = hold(start());
      return original.then(async (value) => {
        const held = { ...value, close: holdClose(() => value.close()) };
        retain(held);
        if (retired || test.signal.aborted) {
          await held.close();
          throw new RelayError("UNAVAILABLE");
        }
        return held;
      });
    });
  const retire = () => {
    if (retired) return;
    retired = true;
    lifetime.retire();
    for (const host of hosts) host.retire();
    // close() starts work/transport retirement synchronously; its exact promise
    // remains held even when a native error occurs during timeout cleanup.
    for (const close of closers) void close();
  };
  const onAbort = () => {
    freezeFailure();
    retire();
  };
  // Install both owners before identity creation, listening or viewer lookup.
  test.signal.addEventListener("abort", onAbort, { once: true });
  test.onTestFailed(() => {
    freezeFailure();
    try {
      Effect.runSync(Effect.logError("Synthetic relay mesh failure phase", failure));
    } catch {
      // Passive fixed metadata never replaces the original failure or logs
      // native errors, payloads, keys, identities, URLs or environment values.
    }
  });
  test.onTestFinished(async () => {
    freezeFailure();
    retire();
    try {
      // Retirement refuses new acquisitions. Already admitted adoption promises
      // join their late close before the final snapshot of exact close owners.
      await Promise.allSettled([...pending]);
      const closed = await Promise.allSettled([...closers].map((close) => close()));
      if (closed.some((result) => result.status === "rejected"))
        throw new Error("fixture-native-close-failed");
    } finally {
      test.signal.removeEventListener("abort", onAbort);
    }
  });
  if (test.signal.aborted) onAbort();
  return {
    lifetime,
    work,
    servers,
    run,
    add: (next: MeshPhase, start: () => ReturnType<typeof startRelayServer>) =>
      acquire(next, start, (server) => servers.push(server)),
    viewer: (next: MeshPhase, start: () => ReturnType<typeof connectViewer>) =>
      acquire(next, start, (viewer) => viewers.push(viewer)),
    host: (host: RelayHost) => {
      assertActive();
      hosts.add(host);
      return holdClose(() => host.close());
    },
  };
}

describe("native three-node private mesh", () => {
  it("adds nodes under one root, redirects discovery, and resumes on a survivor with fresh Noise", async (test) => {
    const fixture = owner(test);
    const [root, nodeA, nodeB, nodeC, admission, hostIdentity, device, viewerAdmission] =
      await fixture.run("identities", () =>
        Promise.all(Array.from({ length: 8 }, () => createIdentity())),
      );
    const identities = [nodeA!, nodeB!, nodeC!];
    const members = identities.map((identity, index) => ({
      id: deriveIdentityId("node", identity.publicKey),
      publicKey: identity.publicKey,
      url: `ws://127.0.0.1:${10001 + index}/v1/relay`,
    }));
    const locator = randomOpaque(),
      capacityToken = randomOpaque(),
      secret = randomOpaque(),
      bearer = randomOpaque();
    const peers = new Map<string, string>(),
      byId = new Map<string, Awaited<ReturnType<typeof startRelayServer>>>();
    const grants = [
      {
        locator,
        admissionPublicKey: admission!.publicKey,
        tokenDigest: opaque(sha256(unopaque(capacityToken, 32))),
      },
    ];
    let revision = 0;
    const networkFor = (count: number) =>
      signNetwork({
        root: root!,
        revision: ++revision,
        expiresAt: epochNow() + 3_600_000,
        nodes: members.slice(0, count),
      });
    const firstNetwork = await fixture.run("network-first", () => networkFor(1));
    const first = await fixture.add("listen-first", () =>
      startRelayServer({
        network: firstNetwork,
        nodeId: members[0]!.id,
        nodeIdentity: identities[0]!,
        grants,
        host: "127.0.0.1",
        port: 0,
        meshListen: { host: "127.0.0.1", port: 0 },
        meshPeerUrls: peers,
        allowLoopbackTest: true,
        manualMeshSync: true,
      }),
    );
    byId.set(members[0]!.id, first);
    peers.set(members[0]!.id, `http://127.0.0.1:${first.meshPort}/v1/mesh`);
    const secondNetwork = await fixture.run("network-second", () => networkFor(2));
    await fixture.run("update-first", () => first.updateNetwork(canonicalBytes(secondNetwork)));
    const second = await fixture.add("listen-second", () =>
      startRelayServer({
        network: secondNetwork,
        nodeId: members[1]!.id,
        nodeIdentity: identities[1]!,
        grants,
        host: "127.0.0.1",
        port: 0,
        meshListen: { host: "127.0.0.1", port: 0 },
        meshPeerUrls: peers,
        allowLoopbackTest: true,
        manualMeshSync: true,
      }),
    );
    byId.set(members[1]!.id, second);
    peers.set(members[1]!.id, `http://127.0.0.1:${second.meshPort}/v1/mesh`);
    let network = await fixture.run("network-third", () => networkFor(3));
    await fixture.run("update-first", () => first.updateNetwork(canonicalBytes(network)));
    await fixture.run("update-second", () => second.updateNetwork(canonicalBytes(network)));
    const third = await fixture.add("listen-third", () =>
      startRelayServer({
        network,
        nodeId: members[2]!.id,
        nodeIdentity: identities[2]!,
        grants,
        host: "127.0.0.1",
        port: 0,
        meshListen: { host: "127.0.0.1", port: 0 },
        meshPeerUrls: peers,
        allowLoopbackTest: true,
        manualMeshSync: true,
      }),
    );
    byId.set(members[2]!.id, third);
    peers.set(members[2]!.id, `http://127.0.0.1:${third.meshPort}/v1/mesh`);
    for (const member of members)
      member.url = `ws://127.0.0.1:${byId.get(member.id)!.port}/v1/relay`;
    network = await fixture.run("network-third", () => networkFor(3));
    await fixture.run("membership", () =>
      Promise.all(
        [first, second, third].map((server) => server.updateNetwork(canonicalBytes(network))),
      ),
    );
    let boundDevice: string | undefined;
    const host = new RelayHost({
      work: fixture.work,
      network,
      identity: hostIdentity!,
      credentials: members.map((node) => ({
        nodeId: node.id,
        locator,
        token: capacityToken,
        admissionIdentity: admission!,
      })),
      dial: (node, resources) =>
        connectNative(`ws://127.0.0.1:${byId.get(node.id)!.port}/v1/relay`, resources),
      measureLatency: async (node) => members.findIndex((member) => member.id === node.id) * 10 + 1,
      allowLoopbackTest: true,
      handlers: {
        authenticate: async (auth, key) => {
          if (auth.environmentId !== "mesh-test-environment")
            throw new RelayError("ENVIRONMENT_MISMATCH");
          if (auth.operation === "pair" && auth.credential === secret && !boundDevice)
            boundDevice = key;
          else if (auth.operation !== "resume" || auth.credential !== bearer || key !== boundDevice)
            throw new RelayError("AUTH_REJECTED");
          return {
            environmentId: auth.environmentId,
            bearerToken: bearer,
            role: "client",
            expiresAt: epochNow() + 3_600_000,
          };
        },
        open: async (stream) => {
          await stream.accept({ status: 200 });
          for (;;) {
            const chunk = await stream.read();
            if (!chunk) break;
            await stream.write(chunk);
          }
          await stream.finish();
        },
      },
    });
    const closeHost = fixture.host(host);
    await fixture.run("host-start", () => host.start());
    expect(host.stats().servingNodes).toEqual(members.slice(0, 2).map((member) => member.id));
    await fixture.run("mesh-sync", () => third.mesh!.sync());
    expect(
      third.broker.directory
        .lookup(locator, epochNow())
        .candidates.map((candidate) => candidate.nodeId),
    ).toEqual(members.slice(0, 2).map((member) => member.id));
    const invitation = await fixture.run("invitation", () => host.invitationTicket());
    const target = {
      network,
      hostPublicKey: hostIdentity!.publicKey,
      environmentId: "mesh-test-environment",
      locator,
      preferredNodeId: members[2]!.id,
      deviceIdentity: device!,
      tickets: [
        {
          nodeId: invitation.node.id,
          registrationId: invitation.registrationId,
          token: invitation.token,
          expiresAt: invitation.expiresAt,
          admissionIdentity: viewerAdmission!,
        },
      ],
      paired: false,
    };
    const viewerOptions = {
      lifetime: fixture.lifetime,
      allowLoopbackTest: true,
      dial: (node: (typeof members)[number], resources: Parameters<typeof connectNative>[1]) =>
        connectNative(`ws://127.0.0.1:${byId.get(node.id)!.port}/v1/relay`, resources),
      fetcher: (input: string, init: RequestInit) => {
        const url = new URL(input),
          member = members.find((node) => new URL(node.url).port === url.port)!;
        url.port = String(byId.get(member.id)!.port);
        return fetch(url.href, init);
      },
    };
    const viewer = await fixture.viewer("viewer-connect", () =>
      connectViewer({ ...viewerOptions, target }),
    );
    await fixture.run("pair-auth", () =>
      viewer.session.authenticate({
        environmentId: target.environmentId,
        operation: "pair",
        credential: secret,
      }),
    );
    expect(viewer.nodeId).toBe(members[0]!.id);
    expect(third.broker.stats().circuits).toBe(0);
    expect(first.broker.stats().circuits).toBe(1);
    const socket = await fixture.run("open-before", () => viewer.session.open("rpc", {}));
    await fixture.run("metadata-before", () => socket.metadata);
    await fixture.run("write-before", () => socket.write(utf8.encode("before-node-loss")));
    expect(await fixture.run("read-before", () => socket.read())).toEqual(
      utf8.encode("before-node-loss"),
    );
    await fixture.run("first-close", () => first.close());
    await fixture.run("viewer-closed", () => viewer.session.closed);
    const resumed = await fixture.viewer("resume-connect", () =>
      connectViewer({
        ...viewerOptions,
        target: { ...target, paired: true, tickets: [] },
      }),
    );
    await fixture.run("resume-auth", () =>
      resumed.session.authenticate({
        environmentId: target.environmentId,
        operation: "resume",
        credential: bearer,
      }),
    );
    expect(resumed.nodeId).toBe(members[1]!.id);
    expect(resumed.session).not.toBe(viewer.session);
    expect(resumed.session.remotePublicKey).toBe(hostIdentity!.publicKey);
    const recovered = await fixture.run("open-after", () => resumed.session.open("rpc", {}));
    await fixture.run("metadata-after", () => recovered.metadata);
    await fixture.run("write-after", () => recovered.write(utf8.encode("after-node-loss")));
    expect(await fixture.run("read-after", () => recovered.read())).toEqual(
      utf8.encode("after-node-loss"),
    );
    const foreignRoot = await fixture.run("foreign-identity", () => createIdentity());
    const foreign = await fixture.run("foreign-network", () =>
      signNetwork({
        root: foreignRoot,
        revision: 100,
        expiresAt: epochNow() + 3_600_000,
        nodes: members,
      }),
    );
    await fixture.run("foreign-refusal", () =>
      expect(second.updateNetwork(canonicalBytes(foreign))).rejects.toMatchObject({
        code: "NETWORK_MISMATCH",
      }),
    );
    expect(second.broker.stats().registrations).toBe(1);
    await fixture.run("resumed-close", () => resumed.close());
    await fixture.run("host-close", () => closeHost());
    await fixture.run("second-close", () => second.close());
    await fixture.run("third-close", () => third.close());
    for (const server of fixture.servers)
      expect(server.stats()).toMatchObject({
        owners: 0,
        pendingBytes: 0,
        nativeSockets: 0,
        circuits: 0,
      });
  });
});
