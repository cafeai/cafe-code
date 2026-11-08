import { describe, expect, it, type TestContext } from "vitest";
import { startRelayServer } from "./server.ts";
import { createIdentity, deriveIdentityId, sha256 } from "@cafecode/relay/crypto";
import { canonicalBytes } from "@cafecode/relay/protocol";
import { opaque, randomOpaque, unopaque, utf8 } from "@cafecode/relay/bytes";
import { signNetwork } from "@cafecode/relay/descriptor";
import { RelayHost } from "@cafecode/relay/host";
import { connectViewer } from "@cafecode/relay/client";
import { connectNative } from "@cafecode/relay/nativeWire";
import { RelayError } from "@cafecode/relay/errors";
import { epochNow, Lifetime } from "@cafecode/relay/lifetime";

function owner(test: TestContext) {
  const lifetime = new Lifetime(),
    servers: Array<Awaited<ReturnType<typeof startRelayServer>>> = [],
    closers = new Set<() => Promise<void>>();
  let retired = false;
  const retire = () => {
    retired = true;
    lifetime.retire();
    for (const close of closers) void close();
    for (const server of servers) void server.close();
  };
  test.signal.addEventListener("abort", retire, { once: true });
  test.onTestFinished(async () => {
    retire();
    await Promise.allSettled([...closers].map((close) => close()));
    await Promise.allSettled(servers.map((server) => server.close()));
    await lifetime.close();
  });
  return {
    lifetime,
    servers,
    closers,
    add: async (server: Awaited<ReturnType<typeof startRelayServer>>) => {
      servers.push(server);
      if (retired) {
        await server.close();
        throw new Error("fixture-retired");
      }
      return server;
    },
  };
}

describe("native three-node private mesh", () => {
  it("adds nodes under one root, redirects discovery, and resumes on a survivor with fresh Noise", async (test) => {
    const fixture = owner(test);
    const [root, nodeA, nodeB, nodeC, admission, hostIdentity, device, viewerAdmission] =
      await Promise.all(Array.from({ length: 8 }, () => createIdentity()));
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
    const firstNetwork = await networkFor(1);
    const first = await fixture.add(
      await startRelayServer({
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
    const secondNetwork = await networkFor(2);
    await first.updateNetwork(canonicalBytes(secondNetwork));
    const second = await fixture.add(
      await startRelayServer({
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
    const network = await networkFor(3);
    await first.updateNetwork(canonicalBytes(network));
    await second.updateNetwork(canonicalBytes(network));
    const third = await fixture.add(
      await startRelayServer({
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
    let boundDevice: string | undefined;
    const host = new RelayHost({
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
    fixture.closers.add(() => host.close());
    await host.start();
    expect(host.stats().servingNodes).toEqual(members.slice(0, 2).map((member) => member.id));
    await third.mesh!.sync();
    expect(
      third.broker.directory
        .lookup(locator, epochNow())
        .candidates.map((candidate) => candidate.nodeId),
    ).toEqual(members.slice(0, 2).map((member) => member.id));
    const invitation = await host.invitationTicket();
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
    const viewer = await connectViewer({ ...viewerOptions, target });
    fixture.closers.add(viewer.close);
    await viewer.session.authenticate({
      environmentId: target.environmentId,
      operation: "pair",
      credential: secret,
    });
    expect(viewer.nodeId).toBe(members[0]!.id);
    expect(third.broker.stats().circuits).toBe(0);
    expect(first.broker.stats().circuits).toBe(1);
    const socket = await viewer.session.open("rpc", {});
    await socket.metadata;
    await socket.write(utf8.encode("before-node-loss"));
    expect(await socket.read()).toEqual(utf8.encode("before-node-loss"));
    await first.close();
    await viewer.session.closed;
    const resumed = await connectViewer({
      ...viewerOptions,
      target: { ...target, paired: true, tickets: [] },
    });
    fixture.closers.add(resumed.close);
    await resumed.session.authenticate({
      environmentId: target.environmentId,
      operation: "resume",
      credential: bearer,
    });
    expect(resumed.nodeId).toBe(members[1]!.id);
    expect(resumed.session).not.toBe(viewer.session);
    expect(resumed.session.remotePublicKey).toBe(hostIdentity!.publicKey);
    const recovered = await resumed.session.open("rpc", {});
    await recovered.metadata;
    await recovered.write(utf8.encode("after-node-loss"));
    expect(await recovered.read()).toEqual(utf8.encode("after-node-loss"));
    const foreignRoot = await createIdentity();
    const foreign = await signNetwork({
      root: foreignRoot,
      revision: 100,
      expiresAt: epochNow() + 3_600_000,
      nodes: members,
    });
    await expect(second.updateNetwork(canonicalBytes(foreign))).rejects.toMatchObject({
      code: "NETWORK_MISMATCH",
    });
    expect(second.broker.stats().registrations).toBe(1);
    await resumed.close();
    await host.close();
    await second.close();
    await third.close();
    for (const server of fixture.servers)
      expect(server.stats()).toMatchObject({
        owners: 0,
        pendingBytes: 0,
        nativeSockets: 0,
        circuits: 0,
      });
  });
});
