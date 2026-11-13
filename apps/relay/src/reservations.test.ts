import { describe, expect, it } from "vitest";
import { createIdentity, deriveIdentityId, sha256, signBytes } from "@cafecode/relay/crypto";
import { randomOpaque, opaque, unopaque } from "@cafecode/relay/bytes";
import {
  HOST_WORK,
  hostWorkDigest,
  hostWorkPrefix,
  hasWorkBits,
  hostWorkProof,
  type HostWorkChallenge,
  type HostWorkSolutions,
  type HostReservation,
} from "@cafecode/relay/hostWork";
import { HostReservations } from "./reservations.ts";
import { HostWorkClaim } from "@cafecode/relay/hostWork";
import { canonicalBytes, readCanonical, OUTER, ZERO_CIRCUIT } from "@cafecode/relay/protocol";
import { RelayBroker } from "@cafecode/relay/broker";
import { RelayLeg } from "@cafecode/relay/leg";
import {
  PacketConnection,
  relayResources,
  type WireDriver,
  type WireCallbacks,
} from "@cafecode/relay/wire";
import { signNetwork } from "@cafecode/relay/descriptor";
import { epochNow } from "@cafecode/relay/lifetime";
import { selfServiceHostLocator } from "@cafecode/relay/admission";

function solve(challenge: HostWorkChallenge): HostWorkSolutions {
  const prefix = hostWorkPrefix(challenge),
    values: [number, number, number, number] = [0, 0, 0, 0];
  for (let part = 0; part < 4; part++) {
    while (!hasWorkBits(hostWorkDigest(prefix, part, values[part]!), challenge.difficulty - 2))
      values[part]!++;
  }
  return values;
}
async function fixture() {
  const identity = await createIdentity(),
    token = randomOpaque(),
    locator = randomOpaque(),
    networkId = randomOpaque(),
    nodeId = randomOpaque();
  let now = 1000;
  const input = {
    enabled: true,
    networkId,
    nodeId,
    grants: [
      {
        locator,
        admissionPublicKey: identity.publicKey,
        tokenDigest: opaque(sha256(unopaque(token, 32))),
      },
    ],
    now: () => now,
    difficulty: 8,
    reservationMs: 10_000,
  };
  const authority = new HostReservations(input);
  const challenge = (reservation?: HostReservation) =>
    authority.challenge({
      version: 1,
      networkId,
      locator,
      admissionPublicKey: identity.publicKey,
      capacityToken: token,
      claimId: randomOpaque(16),
      reservationId: reservation?.credential.id ?? null,
    });
  const claim = async (value = challenge()) => {
    const proof = { challenge: value, solutions: solve(value) };
    return { ...proof, signature: await signBytes(identity, hostWorkProof(proof)) };
  };
  const release = async (reservation: HostReservation) => {
    const value = {
      networkId,
      nodeId,
      bootId: authority.bootId,
      locator,
      admissionPublicKey: identity.publicKey,
      credential: reservation.credential,
    };
    return authority.release({
      ...value,
      signature: await signBytes(identity, hostWorkProof(value, true)),
    });
  };
  return {
    authority,
    input,
    identity,
    token,
    locator,
    challenge,
    claim,
    release,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("work-paid host reservations", () => {
  it("requires paid work and exact key ownership for explicit self-service enrollment", async () => {
    const f = await fixture(),
      attacker = await createIdentity();
    const authority = new HostReservations({ ...f.input, grants: [], selfService: true });
    try {
      const locator = selfServiceHostLocator(f.input.networkId, f.identity.publicKey);
      const request = {
        version: 1 as const,
        networkId: f.input.networkId,
        locator,
        admissionPublicKey: f.identity.publicKey,
        capacityToken: null,
        claimId: randomOpaque(16),
        reservationId: null,
      };
      const challenge = authority.challenge(request);
      expect(() => authority.authorize(locator, f.identity.publicKey, undefined)).toThrow();
      const paid = await authority.claim(await f.claim(challenge));
      expect(authority.authorize(locator, f.identity.publicKey, paid.credential)).toEqual(paid);
      expect(() =>
        authority.challenge({ ...request, admissionPublicKey: attacker.publicKey }),
      ).toThrow();
      expect(() => authority.challenge({ ...request, capacityToken: randomOpaque() })).toThrow();
      expect(() => authority.authorize(locator, attacker.publicKey, paid.credential)).toThrow();
      f.advance(10_001);
      // Expiry must not make another machine's locator claimable.
      expect(() =>
        authority.challenge({ ...request, admissionPublicKey: attacker.publicKey }),
      ).toThrow();
      expect(() => authority.authorize(locator, f.identity.publicKey, paid.credential)).toThrow();
      const fresh = authority.challenge({ ...request, claimId: randomOpaque(16) });
      const proof = { challenge: fresh, solutions: solve(fresh) };
      await expect(
        authority.claim({ ...proof, signature: await signBytes(attacker, hostWorkProof(proof)) }),
      ).rejects.toThrow();
      expect(authority.stats().reservations).toBe(0);
    } finally {
      authority.retire();
      f.authority.retire();
    }
  });

  it("keeps self-service disabled by default and never bypasses operator enrollment", async () => {
    const f = await fixture();
    const authority = new HostReservations({ ...f.input, selfService: true });
    try {
      const request = {
        version: 1 as const,
        networkId: f.input.networkId,
        locator: selfServiceHostLocator(f.input.networkId, f.identity.publicKey),
        admissionPublicKey: f.identity.publicKey,
        capacityToken: null,
        claimId: randomOpaque(16),
        reservationId: null,
      };
      expect(() => f.authority.challenge(request)).toThrow();
      expect(() => authority.challenge({ ...request, locator: f.locator })).toThrow();
      const challenge = f.challenge();
      const unsigned = { challenge, solutions: [0, 0, 0, 0] as const };
      await expect(
        authority.claim({
          ...unsigned,
          signature: await signBytes(f.identity, hostWorkProof(unsigned)),
        }),
      ).rejects.toThrow();
      expect(authority.stats().reservations).toBe(0);
    } finally {
      authority.retire();
      f.authority.retire();
    }
  });
  it("keeps the 17-bit baseline available when proof of work is explicitly enabled", async () => {
    const f = await fixture();
    const authority = new HostReservations({
      enabled: true,
      networkId: f.input.networkId,
      nodeId: f.input.nodeId,
      grants: f.input.grants,
      now: f.input.now,
    });
    try {
      const challenge = authority.challenge({
        version: 1,
        networkId: f.input.networkId,
        locator: f.locator,
        admissionPublicKey: f.identity.publicKey,
        capacityToken: f.token,
        claimId: randomOpaque(16),
        reservationId: null,
      });
      expect(challenge.difficulty).toBe(17);
      expect(challenge.reservationMs).toBe(600_000);
    } finally {
      authority.retire();
      f.authority.retire();
    }
  });
  it.each([true, false])(
    "disables work while retaining signed admission (zero-capable host: %s)",
    async (acceptsZero) => {
      const f = await fixture();
      const { enabled: _enabled, ...options } = f.input;
      const authority = new HostReservations(options);
      try {
        const challenge = authority.challenge(
          {
            version: 1,
            networkId: f.input.networkId,
            locator: f.locator,
            admissionPublicKey: f.identity.publicKey,
            capacityToken: f.token,
            claimId: randomOpaque(16),
            reservationId: null,
          },
          acceptsZero,
        );
        expect(challenge.difficulty).toBe(acceptsZero ? 0 : 2);
        const proof = { challenge, solutions: [0, 0, 0, 0] as const };
        await expect(
          authority.claim({
            ...proof,
            signature: await signBytes(await createIdentity(), hostWorkProof(proof)),
          }),
        ).rejects.toThrow();
        const reservation = await authority.claim({
          ...proof,
          signature: await signBytes(f.identity, hostWorkProof(proof)),
        });
        expect(reservation.locator).toBe(f.locator);
        expect(
          authority.authorize(f.locator, f.identity.publicKey, reservation.credential),
        ).toEqual(reservation);
      } finally {
        authority.retire();
        f.authority.retire();
      }
    },
  );
  it("reclaims a lost reservation with fresh host work and fences a delayed old release", async () => {
    const f = await fixture(),
      firstProof = await f.claim(),
      first = await f.authority.claim(firstProof);
    f.advance(1000);
    const challenge = f.challenge();
    expect(challenge.replace).toBe(true);
    expect(challenge.reservationId).toBe(first.credential.id);
    const proof = await f.claim(challenge),
      replacement = await f.authority.claim(proof);
    expect(replacement.credential.id).not.toBe(first.credential.id);
    expect(replacement.credential.token).not.toBe(first.credential.token);
    await f.release(first);
    expect(f.authority.authorize(f.locator, f.identity.publicKey, replacement.credential)).toEqual(
      replacement,
    );
    expect(await f.authority.claim(proof)).toEqual(replacement);
    await expect(f.authority.claim(firstProof)).rejects.toThrow();
    expect(f.authority.stats().reservations).toBe(1);
    f.authority.retire();
  });
  it("retires a live registration when a heartbeat arrives after its paid expiry", async (test) => {
    const connections: PacketConnection[] = [];
    let broker: RelayBroker | undefined;
    const retire = () => {
      for (const connection of connections) connection.retire();
    };
    test.signal.addEventListener("abort", retire, { once: true });
    test.onTestFinished(async () => {
      retire();
      await broker?.close();
      await Promise.all(connections.map((connection) => connection.close()));
    });
    const f = await fixture(),
      root = await createIdentity(),
      node = await createIdentity();
    const nodeId = deriveIdentityId("node", node.publicKey),
      network = await signNetwork({
        root,
        revision: 1,
        expiresAt: epochNow() + 3_600_000,
        nodes: [{ id: nodeId, publicKey: node.publicKey, url: "ws://127.0.0.1:1/v1/relay" }],
      });
    let now = epochNow();
    const authority = new HostReservations({
      ...f.input,
      networkId: network.networkId,
      nodeId,
      now: () => now,
      reservationMs: 1000,
    });
    test.onTestFinished(() => {
      authority.retire();
      f.authority.retire();
    });
    const challenge = authority.challenge({
      version: 1,
      networkId: network.networkId,
      locator: f.locator,
      admissionPublicKey: f.identity.publicKey,
      capacityToken: f.token,
      claimId: randomOpaque(16),
      reservationId: null,
    });
    const paid = await authority.claim(await f.claim(challenge));
    const callbacks: Array<WireCallbacks | undefined> = [],
      resources = relayResources();
    const driver = (index: number): WireDriver => ({
      install(value) {
        callbacks[index] = value;
        queueMicrotask(() => value.open());
      },
      send(bytes, flushed) {
        const held = bytes.slice();
        queueMicrotask(() => {
          callbacks[1 - index]!.message(held);
          flushed(true);
        });
      },
      terminate() {
        callbacks[index]?.close();
        callbacks[1 - index]?.close();
      },
    });
    const client = new PacketConnection(driver(0), resources, () => {}),
      server = new PacketConnection(driver(1), resources, () => {});
    connections.push(client, server);
    broker = new RelayBroker({
      network,
      nodeId,
      resources,
      grants: f.input.grants,
      reservations: authority,
      now: () => now,
    });
    const leg = new RelayLeg(client, resources, network.networkId, nodeId);
    await Promise.all([client.opened, server.opened]);
    broker.accept(server);
    const registered = await leg.register(f.locator, f.token, f.identity, 0, paid.credential);
    expect(broker.stats().registrations).toBe(1);
    now += 1001;
    leg.send(OUTER.LEASE, ZERO_CIRCUIT, { registrationId: registered.registrationId, priority: 0 });
    await client.closed;
    expect(broker.stats().registrations).toBe(0);
    expect(authority.stats().reservations).toBe(0);
  });
  it("issues no reservation until valid work and host proof commit; replays reconcile exactly once", async () => {
    const f = await fixture(),
      work = await f.claim();
    expect(f.authority.stats()).toMatchObject({ reservations: 0, receipts: 0 });
    expect(() => f.authority.authorize(f.locator, f.identity.publicKey, undefined)).toThrow();
    const [a, b] = await Promise.all([f.authority.claim(work), f.authority.claim(work)]);
    expect(a).toEqual(b);
    f.advance(1000);
    expect(await f.authority.claim(work)).toEqual(a);
    expect(f.authority.stats()).toEqual({ reservations: 1, receipts: 1, checking: 0 });
    expect(f.authority.authorize(f.locator, f.identity.publicKey, a.credential)).toEqual(a);
    expect(() =>
      f.authority.authorize(f.locator, f.identity.publicKey, {
        ...a.credential,
        token: randomOpaque(),
      }),
    ).toThrow();
    expect(() => f.authority.authorize(f.locator, randomOpaque(), a.credential)).toThrow();
    await f.release(a);
    expect(f.authority.expiry(f.locator, a.credential.id)).toBe(0);
    await expect(f.authority.claim(work)).rejects.toThrow();
    f.authority.retire();
  });

  it("rejects altered difficulty, purpose scope, replay on another boot, missing work and wrong signer", async () => {
    const f = await fixture(),
      work = await f.claim();
    for (const change of [
      { difficulty: 2 },
      { nodeId: randomOpaque() },
      { networkId: randomOpaque() },
      { locator: randomOpaque() },
      { admissionPublicKey: randomOpaque() },
      { bootId: randomOpaque(16) },
      { expiresAt: work.challenge.expiresAt + 1 },
      { nonce: randomOpaque() },
      { slots: 2 },
    ])
      await expect(async () =>
        f.authority.claim(
          readCanonical(
            HostWorkClaim,
            canonicalBytes({ ...work, challenge: { ...work.challenge, ...change } }),
          ),
        ),
      ).rejects.toThrow();
    const badSolutions: [number, number, number, number] = [...work.solutions];
    const prefix = hostWorkPrefix(work.challenge);
    while (hasWorkBits(hostWorkDigest(prefix, 3, badSolutions[3]), work.challenge.difficulty - 2))
      badSolutions[3]++;
    await expect(f.authority.claim({ ...work, solutions: badSolutions })).rejects.toThrow();
    const foreign = await createIdentity();
    await expect(
      f.authority.claim({
        ...work,
        signature: await signBytes(
          foreign,
          hostWorkProof({ challenge: work.challenge, solutions: work.solutions }),
        ),
      }),
    ).rejects.toThrow();
    const replacement = new HostReservations(f.input);
    await expect(replacement.claim(work)).rejects.toThrow();
    expect(f.authority.stats().reservations).toBe(0);
    f.authority.retire();
    replacement.retire();
  });

  it("charges renewal again, preserves the reconnect credential and never extends a replayed proof", async () => {
    const f = await fixture(),
      original = await f.authority.claim(await f.claim());
    f.advance(8000);
    const work = await f.claim(f.challenge(original)),
      renewed = await f.authority.claim(work);
    expect(renewed.credential).toEqual(original.credential);
    expect(renewed.expiresAt).toBe(original.expiresAt + 8000);
    f.advance(5000);
    expect(await f.authority.claim(work)).toEqual(renewed);
    expect(f.authority.authorize(f.locator, f.identity.publicKey, original.credential)).toEqual(
      renewed,
    );
    f.advance(5001);
    expect(() =>
      f.authority.authorize(f.locator, f.identity.publicKey, original.credential),
    ).toThrow();
    expect(() => f.challenge(original)).toThrow();
    expect(f.authority.stats().reservations).toBe(0);
    f.authority.retire();
  });

  it("expires unused challenges and fences admitted verification at retirement", async () => {
    const f = await fixture(),
      work = await f.claim();
    f.advance(HOST_WORK.challengeMs + 1);
    await expect(f.authority.claim(work)).rejects.toThrow();
    const next = await f.claim(),
      pending = f.authority.claim(next);
    f.authority.retire();
    await expect(pending).rejects.toThrow();
    expect(f.authority.stats()).toEqual({ reservations: 0, receipts: 0, checking: 0 });
  });

  it("raises occupancy difficulty with cooldown and accepts already-issued lower work", async () => {
    const f = await fixture(),
      locators = Array.from({ length: 32 }, () => randomOpaque());
    let now = 1000;
    const authority = new HostReservations({
      ...f.input,
      now: () => now,
      reservationMs: HOST_WORK.reservationMs,
      grants: locators.map((locator) => ({ ...f.input.grants[0]!, locator })),
    });
    const issue = (index: number) =>
      authority.challenge({
        version: 1,
        networkId: f.input.networkId,
        locator: locators[index]!,
        admissionPublicKey: f.identity.publicKey,
        capacityToken: f.token,
        claimId: randomOpaque(16),
        reservationId: null,
      });
    const paid: HostReservation[] = [];
    for (let index = 0; index < 23; index++)
      paid.push(await authority.claim(await f.claim(issue(index))));
    const old = issue(24);
    paid.push(await authority.claim(await f.claim(issue(23))));
    expect(issue(24).difficulty).toBe(9);
    expect(old.difficulty).toBe(8);
    paid.push(await authority.claim(await f.claim(old)));
    for (let index = 25; index < 28; index++)
      paid.push(await authority.claim(await f.claim(issue(index))));
    expect(issue(28).difficulty).toBe(9);
    now += 30_000;
    const higher = issue(28);
    expect(higher.difficulty).toBe(10);
    paid.push(await authority.claim(await f.claim(higher)));
    for (const value of paid.slice(0, 12)) {
      const unsigned = {
        networkId: value.networkId,
        nodeId: value.nodeId,
        bootId: value.bootId,
        locator: value.locator,
        admissionPublicKey: value.admissionPublicKey,
        credential: value.credential,
      };
      await authority.release({
        ...unsigned,
        signature: await signBytes(f.identity, hostWorkProof(unsigned, true)),
      });
    }
    now += 30_000;
    expect(issue(0).difficulty).toBe(9);
    now += 30_000;
    expect(issue(0).difficulty).toBe(8);
    authority.retire();
    f.authority.retire();
  });

  it("bounds concurrent verifiers and retained receipts without evicting live replay protection", async () => {
    const f = await fixture(),
      challenges = Array.from({ length: 5 }, () => f.challenge());
    const claims = await Promise.all(challenges.map((value) => f.claim(value)));
    const pending = claims.slice(0, 4).map((value) => f.authority.claim(value));
    await expect(f.authority.claim(claims[4]!)).rejects.toThrow();
    const first = await Promise.allSettled(pending);
    expect(first.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    let paid = f.authority.authorize(
      f.locator,
      f.identity.publicKey,
      first.find((value) => value.status === "fulfilled")!.value.credential,
    );
    for (let index = 1; index < HOST_WORK.receipts; index++)
      paid = await f.authority.claim(await f.claim(f.challenge(paid)));
    await expect(f.authority.claim(await f.claim(f.challenge(paid)))).rejects.toThrow();
    expect(f.authority.stats()).toEqual({
      reservations: 1,
      receipts: HOST_WORK.receipts,
      checking: 0,
    });
    f.advance(HOST_WORK.challengeMs + HOST_WORK.receiptMs + 1);
    expect(f.authority.stats()).toEqual({ reservations: 0, receipts: 0, checking: 0 });
    f.authority.retire();
  });
});
