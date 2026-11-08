import { describe, expect, it } from "vitest";
import { canonicalBytes } from "./protocol.ts";
import { createIdentity, deriveIdentityId } from "./crypto.ts";
import { signNetwork, verifyNetwork } from "./descriptor.ts";
import { createInvitationUrl, parseInvitationUrl } from "./invitation.ts";
import { randomOpaque } from "./bytes.ts";
import { TicketStore } from "./tickets.ts";
import { RelayDirectory } from "./directory.ts";

describe("pinned network discovery and full-strength invitations", () => {
  it("rejects wrong roots, signature tampering, rollbacks, expired and unsafe endpoints", async () => {
    const [root, node, wrong] = await Promise.all([
      createIdentity(),
      createIdentity(),
      createIdentity(),
    ]);
    const descriptor = await signNetwork({
      root,
      revision: 4,
      expiresAt: 50_000,
      nodes: [
        {
          id: deriveIdentityId("node", node.publicKey),
          publicKey: node.publicKey,
          url: "wss://relay.example/v1/relay",
        },
      ],
    });
    const verify = (value: unknown, rootPublicKey = root.publicKey, minimumRevision = 4) =>
      verifyNetwork(canonicalBytes(value), { rootPublicKey, minimumRevision, now: 1_000 });
    expect(await verify(descriptor)).toEqual(descriptor);
    await expect(verify(descriptor, wrong.publicKey)).rejects.toMatchObject({
      code: "NETWORK_MISMATCH",
    });
    await expect(verify({ ...descriptor, expiresAt: 90_000 })).rejects.toThrow();
    await expect(verify(descriptor, root.publicKey, 5)).rejects.toThrow();
    await expect(
      verifyNetwork(canonicalBytes(descriptor), { rootPublicKey: root.publicKey, now: 50_000 }),
    ).rejects.toMatchObject({ code: "EXPIRED" });
    const unsafe = await signNetwork({
      root,
      revision: 4,
      expiresAt: 50_000,
      nodes: [{ ...descriptor.nodes[0]!, url: "ws://relay.example/v1/relay" }],
    });
    await expect(verify(unsafe)).rejects.toThrow();
  });
  it("keeps secrets only in the fragment and requires an independently trusted viewer origin", async () => {
    const [root, host, node] = await Promise.all([
      createIdentity(),
      createIdentity(),
      createIdentity(),
    ]);
    const invitation = {
      version: 1 as const,
      networkId: deriveIdentityId("network", root.publicKey),
      networkRootPublicKey: root.publicKey,
      minimumRevision: 1,
      bootstrapUrls: ["https://relay.example/v1/network"],
      hostPublicKey: host.publicKey,
      environmentId: "synthetic-env",
      locator: randomOpaque(),
      nodeId: deriveIdentityId("node", node.publicKey),
      registrationId: randomOpaque(16),
      inviteTicket: randomOpaque(),
      pairingSecret: randomOpaque(),
      expiresAt: 301_000,
    };
    const url = createInvitationUrl("https://viewer.example", invitation, 1_000);
    expect(new URL(url).search).toBe("");
    expect(new URL(url).pathname).toBe("/relay/pair");
    expect(parseInvitationUrl(url, new Set(["https://viewer.example"]), 1_000)).toEqual(invitation);
    expect(() => parseInvitationUrl(url, new Set(["https://evil.example"]), 1_000)).toThrow();
    expect(() => parseInvitationUrl(url, new Set(["https://viewer.example"]), 301_000)).toThrow();
    expect(() =>
      parseInvitationUrl(url + "x".repeat(2304), new Set(["https://viewer.example"]), 1_000),
    ).toThrow();
  });
});

describe("one-use capacity reservations and mesh incarnation ownership", () => {
  it("consumes an exact scoped ticket once across reservation/revocation races", () => {
    const store = new TicketStore(),
      scope = {
        nodeId: randomOpaque(),
        bootId: randomOpaque(16),
        registrationId: randomOpaque(16),
        purpose: "resume" as const,
        admissionPublicKey: randomOpaque(),
      };
    const issued = store.issue(scope, 1000)!;
    expect(
      store.reserve(issued.token, { ...scope, bootId: randomOpaque(16) }, 1001),
    ).toBeUndefined();
    const first = store.reserve(issued.token, scope, 1001)!;
    expect(store.reserve(issued.token, scope, 1001)).toBeUndefined();
    first.release();
    const second = store.reserve(issued.token, scope, 1002)!;
    first.release();
    expect(second.commit(1003)).toBe(true);
    expect(second.commit(1003)).toBe(false);
    const revoked = store.issue(scope, 1004)!;
    const pending = store.reserve(revoked.token, scope, 1005)!;
    store.revokeRegistration(scope.registrationId);
    expect(pending.commit(1006)).toBe(false);
    expect(store.size).toBe(0);
    const expired = store.issue(scope, 1007)!;
    expect(store.reserve(expired.token, scope, expired.expiresAt)).toBeUndefined();
  });
  it("fences a retired peer and works with surviving observations without quorum", async () => {
    const [root, node] = await Promise.all([createIdentity(), createIdentity()]);
    const nodeId = deriveIdentityId("node", node.publicKey),
      network = await signNetwork({
        root,
        revision: 1,
        expiresAt: 500_000,
        nodes: [{ id: nodeId, publicKey: node.publicKey, url: "wss://relay.example/v1/relay" }],
      });
    const directory = new RelayDirectory(network),
      old = directory.begin(nodeId),
      current = directory.begin(nodeId),
      locator = randomOpaque();
    const snapshot = {
      networkId: network.networkId,
      nodeId,
      bootId: randomOpaque(16),
      sequence: 1,
      records: [
        { locator, registrationId: randomOpaque(16), expiresAt: 121_000, priority: 0 as const },
      ],
    };
    expect(old.publish(snapshot, 1000)).toBe(false);
    expect(current.publish(snapshot, 1000)).toBe(true);
    old.retire();
    expect(directory.lookup(locator, 1001).candidates).toHaveLength(1);
    expect(current.publish(snapshot, 1001)).toBe(false);
    expect(directory.lookup(locator, 121_000).candidates).toHaveLength(0);
    current.retire();
    expect(directory.size).toBe(0);
  });
});
