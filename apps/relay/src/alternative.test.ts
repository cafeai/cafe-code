import { expect, it } from "vitest";
import { startRelayServer } from "./server.ts";
import { RelayHost } from "@cafecode/relay/host";
import { connectViewer } from "@cafecode/relay/client";
import { connectNative } from "@cafecode/relay/nativeWire";
import { createIdentity, deriveIdentityId, sha256 } from "@cafecode/relay/crypto";
import { opaque, unopaque, randomOpaque } from "@cafecode/relay/bytes";
import { canonicalBytes } from "@cafecode/relay/protocol";
import { signNetwork } from "@cafecode/relay/descriptor";
import { epochNow, Lifetime } from "@cafecode/relay/lifetime";
import { RelayError } from "@cafecode/relay/errors";
import { fetchRelayed, serveRelayedHttp } from "@cafecode/relay/http";

it("uses a separately selected root without consulting or depending on the official network", async (test) => {
  const lifetime = new Lifetime(),
    servers: Awaited<ReturnType<typeof startRelayServer>>[] = [],
    hosts: RelayHost[] = [];
  let connection: Awaited<ReturnType<typeof connectViewer>> | undefined;
  const retire = () => {
    lifetime.retire();
    for (const host of hosts) host.retire();
    void connection?.close();
    for (const server of servers) void server.close();
  };
  test.signal.addEventListener("abort", retire, { once: true });
  test.onTestFinished(async () => {
    retire();
    await connection?.close();
    await Promise.all(hosts.map((host) => host.close()));
    await Promise.all(servers.map((server) => server.close()));
    await lifetime.close();
  });
  const networks = [];
  for (let index = 0; index < 2; index++) {
    const [root, node, hostIdentity, admission] = await Promise.all(
      Array.from({ length: 4 }, () => createIdentity()),
    );
    if (!lifetime.active) throw new RelayError("UNAVAILABLE");
    const nodeId = deriveIdentityId("node", node!.publicKey),
      locator = randomOpaque(),
      token = randomOpaque(),
      secret = randomOpaque(),
      bearer = randomOpaque();
    let network = await signNetwork({
      root: root!,
      revision: 1,
      expiresAt: epochNow() + 3_600_000,
      nodes: [{ id: nodeId, publicKey: node!.publicKey, url: "ws://127.0.0.1:1/v1/relay" }],
    });
    const server = await startRelayServer({
      network,
      nodeId,
      host: "127.0.0.1",
      port: 0,
      allowLoopbackTest: true,
      grants: [
        {
          locator,
          admissionPublicKey: admission!.publicKey,
          tokenDigest: opaque(sha256(unopaque(token, 32))),
        },
      ],
    });
    servers.push(server);
    if (!lifetime.active) {
      await server.close();
      throw new RelayError("UNAVAILABLE");
    }
    network = await signNetwork({
      root: root!,
      revision: 2,
      expiresAt: epochNow() + 3_600_000,
      nodes: [
        { id: nodeId, publicKey: node!.publicKey, url: `ws://127.0.0.1:${server.port}/v1/relay` },
      ],
    });
    await server.updateNetwork(canonicalBytes(network));
    const host = new RelayHost({
      network,
      identity: hostIdentity!,
      credentials: [{ nodeId, locator, token, admissionIdentity: admission! }],
      allowLoopbackTest: true,
      dial: (node, resources) => connectNative(node.url, resources),
      measureLatency: async () => 1,
      handlers: {
        authenticate: async (input) => {
          if (input.environmentId !== "alternative-fixture" || input.credential !== secret)
            throw new RelayError("AUTH_REJECTED");
          return {
            environmentId: input.environmentId,
            bearerToken: bearer,
            role: "client",
            expiresAt: epochNow() + 60_000,
          };
        },
        open: (stream, metadata) =>
          serveRelayedHttp(
            stream,
            metadata,
            async () => new Response("alternative-network-canary"),
          ),
      },
    });
    hosts.push(host);
    if (!lifetime.active) {
      await host.close();
      throw new RelayError("UNAVAILABLE");
    }
    await host.start();
    networks.push({ network, host, hostIdentity: hostIdentity!, locator, secret });
  }
  const chosen = networks[1]!,
    other = networks[0]!,
    device = await createIdentity(),
    admission = await createIdentity(),
    ticket = await chosen.host.invitationTicket();
  const lookups: string[] = [],
    dials: string[] = [];
  connection = await connectViewer({
    lifetime,
    allowLoopbackTest: true,
    target: {
      network: chosen.network,
      hostPublicKey: chosen.hostIdentity.publicKey,
      environmentId: "alternative-fixture",
      locator: chosen.locator,
      preferredNodeId: ticket.node.id,
      deviceIdentity: device,
      tickets: [
        {
          nodeId: ticket.node.id,
          registrationId: ticket.registrationId,
          token: ticket.token,
          expiresAt: ticket.expiresAt,
          admissionIdentity: admission,
        },
      ],
      paired: false,
    },
    fetcher: (url, init) => {
      lookups.push(url);
      return fetch(url, init);
    },
    dial: (node, resources) => {
      dials.push(node.id);
      return connectNative(node.url, resources);
    },
  });
  if (!lifetime.active) {
    await connection.close();
    throw new RelayError("UNAVAILABLE");
  }
  await connection.session.authenticate({
    environmentId: "alternative-fixture",
    operation: "pair",
    credential: chosen.secret,
  });
  await servers[0]!.close();
  expect(await (await fetchRelayed(connection.session, "/api/canary")).text()).toBe(
    "alternative-network-canary",
  );
  expect(dials).toEqual([ticket.node.id]);
  expect(lookups.every((url) => new URL(url).port === String(servers[1]!.port))).toBe(true);
  expect(chosen.network.networkId).not.toBe(other.network.networkId);
  expect(chosen.hostIdentity.publicKey).not.toBe(other.hostIdentity.publicKey);
});
