import * as Schema from "effect/Schema";
import { concatenate, randomOpaque, utf8 } from "./bytes.ts";
import { Budget, TokenBucket } from "./budget.ts";
import { DirectorySnapshot, Signature } from "./controls.ts";
import { signBytes, verifyBytes, type RelayIdentity } from "./crypto.ts";
import { relayHttpEndpoint, type NetworkDescriptor } from "./descriptor.ts";
import type { RelayDirectory } from "./directory.ts";
import { fetchCanonical, type RelayFetch } from "./discovery.ts";
import { requireRelay } from "./errors.ts";
import { Lifetime, epochNow, monotonicMillis } from "./lifetime.ts";
import { RELAY_LIMITS } from "./limits.ts";
import { Id16, Id32, SafeCounter, canonicalBytes, readCanonical } from "./protocol.ts";

const RequestUnsigned = Schema.Struct({
  version: Schema.Literal(1),
  networkId: Id32,
  nodeId: Id32,
  bootId: Id16,
  nonce: Id32,
  issuedAt: SafeCounter,
});
export const MeshRequest = Schema.Struct({ ...RequestUnsigned.fields, signature: Signature });
const ResponseUnsigned = Schema.Struct({
  nonce: Id32,
  issuedAt: SafeCounter,
  snapshot: DirectorySnapshot,
});
export const MeshResponse = Schema.Struct({ ...ResponseUnsigned.fields, signature: Signature });
const requestDomain = utf8.encode("CafeCode/relay/mesh-request/v1\0");
const responseDomain = utf8.encode("CafeCode/relay/mesh-response/v1\0");

/**
 * Bounded direct polling of every approved member's own snapshot. Signed
 * nonce-bound responses and exact attempt ownership reject delayed replies.
 * Application channels/data never enter this protocol. WG or HTTPS protects
 * routing metadata; the operator supplies private WG addresses independently.
 */
export class RelayMesh {
  private network: NetworkDescriptor;
  private readonly nodeId: string;
  private readonly bootId: string;
  private readonly identity: RelayIdentity;
  private readonly directory: RelayDirectory;
  private readonly snapshot: () => typeof DirectorySnapshot.Type;
  private readonly fetcher: RelayFetch;
  private peerUrls: ReadonlyMap<string, string>;
  private readonly allowLoopbackTest: boolean;
  private readonly lifetime = new Lifetime(() => this.retire());
  private readonly verification = new Budget(2);
  private readonly outgoing = new Budget(2);
  private readonly rate = new TokenBucket(32, 8, epochNow());
  private readonly nonces = new Map<string, number>();
  private readonly jobs = new Set<Promise<void>>();
  private lastDemandRefresh = -Infinity;
  private readonly peers = new Map<
    string,
    {
      readonly owner: ReturnType<RelayDirectory["begin"]>;
      pending: boolean;
      generation: number;
      bootId: string | undefined;
    }
  >();

  constructor(input: {
    readonly network: NetworkDescriptor;
    readonly nodeId: string;
    readonly bootId: string;
    readonly identity: RelayIdentity;
    readonly directory: RelayDirectory;
    readonly snapshot: () => typeof DirectorySnapshot.Type;
    readonly fetcher?: RelayFetch;
    readonly peerUrls?: ReadonlyMap<string, string>;
    readonly allowLoopbackTest?: boolean;
  }) {
    this.network = input.network;
    this.nodeId = input.nodeId;
    this.bootId = input.bootId;
    this.identity = input.identity;
    this.directory = input.directory;
    this.snapshot = input.snapshot;
    this.fetcher = input.fetcher ?? fetch;
    this.peerUrls = input.peerUrls ?? new Map();
    this.allowLoopbackTest = input.allowLoopbackTest ?? false;
    requireRelay(
      this.network.nodes.find((node) => node.id === this.nodeId)?.publicKey ===
        this.identity.publicKey,
      "NETWORK_MISMATCH",
    );
    this.updatePeers();
  }
  private updatePeers(): void {
    for (const [id, peer] of this.peers)
      if (!this.network.nodes.some((node) => node.id === id)) {
        peer.generation++;
        peer.owner.retire();
        this.peers.delete(id);
      }
    for (const node of this.network.nodes)
      if (node.id !== this.nodeId && !this.peers.has(node.id))
        this.peers.set(node.id, {
          owner: this.directory.begin(node.id),
          pending: false,
          generation: 0,
          bootId: undefined,
        });
  }
  update(network: NetworkDescriptor, peerUrls?: ReadonlyMap<string, string>): void {
    requireRelay(
      network.networkId === this.network.networkId &&
        network.rootPublicKey === this.network.rootPublicKey &&
        network.revision > this.network.revision,
      "NETWORK_MISMATCH",
    );
    this.network = network;
    if (peerUrls) this.peerUrls = peerUrls;
    this.updatePeers();
    void Promise.allSettled([...this.jobs]).then(() => {
      if (this.lifetime.active) return this.sync();
    });
  }
  start(): void {
    void this.sync().finally(() => this.schedule());
  }
  private schedule(): void {
    if (this.lifetime.active)
      this.lifetime.later(RELAY_LIMITS.renewMs, () => {
        void this.sync().finally(() => this.schedule());
      });
  }
  async answer(bytes: Uint8Array): Promise<Uint8Array> {
    requireRelay(this.lifetime.active && this.rate.take(epochNow()), "BUSY");
    const release = this.verification.reserve();
    requireRelay(release, "BUSY");
    try {
      const request = readCanonical(MeshRequest, bytes, RELAY_LIMITS.controlBytes),
        now = epochNow();
      const node = this.network.nodes.find((member) => member.id === request.nodeId);
      requireRelay(
        node && node.id !== this.nodeId && request.networkId === this.network.networkId,
        "NETWORK_MISMATCH",
      );
      requireRelay(Math.abs(request.issuedAt - now) <= RELAY_LIMITS.clockSkewMs, "EXPIRED");
      for (const [key, expiresAt] of this.nonces) if (expiresAt <= now) this.nonces.delete(key);
      const replayKey = node.id + ":" + request.nonce;
      requireRelay(
        !this.nonces.has(replayKey) && this.nonces.size < RELAY_LIMITS.directoryEntries,
        "BUSY",
      );
      // Consume before await, including invalid proofs: an async replay cannot
      // run a second verification against the same fresh observation.
      this.nonces.set(replayKey, now + RELAY_LIMITS.clockSkewMs);
      const { signature, ...unsigned } = request;
      requireRelay(
        await verifyBytes(
          node.publicKey,
          concatenate(requestDomain, canonicalBytes(unsigned)),
          signature,
        ),
        "AUTH_DENIED",
      );
      requireRelay(
        this.lifetime.active &&
          this.network.nodes.some(
            (member) => member.id === node.id && member.publicKey === node.publicKey,
          ),
        "NETWORK_MISMATCH",
      );
      const response = { nonce: request.nonce, issuedAt: epochNow(), snapshot: this.snapshot() };
      return canonicalBytes({
        ...response,
        signature: await signBytes(
          this.identity,
          concatenate(responseDomain, canonicalBytes(response)),
        ),
      });
    } finally {
      release();
    }
  }
  sync(): Promise<void> {
    const job = this.performSync();
    this.jobs.add(job);
    void job.then(
      () => this.jobs.delete(job),
      () => this.jobs.delete(job),
    );
    return job;
  }
  async refresh(): Promise<void> {
    if (!this.lifetime.active || monotonicMillis() - this.lastDemandRefresh < 2_000) return;
    this.lastDemandRefresh = monotonicMillis();
    await Promise.allSettled([...this.jobs]);
    if (this.lifetime.active) await this.sync();
  }
  private async performSync(): Promise<void> {
    if (!this.lifetime.active) return;
    // Two in-flight peers at most, independent of the membership maximum.
    const nodes = this.network.nodes.filter((node) => node.id !== this.nodeId);
    for (let offset = 0; offset < nodes.length; offset += 2) {
      await Promise.allSettled(
        nodes.slice(offset, offset + 2).map(async (node) => {
          const peer = this.peers.get(node.id);
          if (!peer || peer.pending || !this.lifetime.active) return;
          const release = this.outgoing.reserve();
          if (!release) return;
          peer.pending = true;
          const generation = ++peer.generation;
          try {
            const unsigned = {
              version: 1 as const,
              networkId: this.network.networkId,
              nodeId: this.nodeId,
              bootId: this.bootId,
              nonce: randomOpaque(),
              issuedAt: epochNow(),
            };
            const request = {
              ...unsigned,
              signature: await signBytes(
                this.identity,
                concatenate(requestDomain, canonicalBytes(unsigned)),
              ),
            };
            const url =
              this.peerUrls.get(node.id) ??
              relayHttpEndpoint(node, "/v1/mesh", this.allowLoopbackTest);
            const response = await fetchCanonical(
              this.fetcher,
              this.lifetime,
              url,
              MeshResponse,
              RELAY_LIMITS.metadataBytes,
              request,
            );
            requireRelay(
              response.nonce === request.nonce &&
                response.snapshot.nodeId === node.id &&
                response.snapshot.networkId === this.network.networkId &&
                Math.abs(response.issuedAt - epochNow()) <= RELAY_LIMITS.clockSkewMs,
            );
            const { signature, ...reply } = response;
            requireRelay(
              await verifyBytes(
                node.publicKey,
                concatenate(responseDomain, canonicalBytes(reply)),
                signature,
              ),
              "AUTH_DENIED",
            );
            requireRelay(
              this.lifetime.active &&
                this.peers.get(node.id) === peer &&
                peer.generation === generation,
            );
            peer.owner.publish(response.snapshot, epochNow());
            peer.bootId = response.snapshot.bootId;
          } finally {
            release();
            if (this.peers.get(node.id) === peer && peer.generation === generation)
              peer.pending = false;
          }
        }),
      );
    }
  }
  retire(): void {
    this.lifetime.retire();
    for (const peer of this.peers.values()) {
      peer.generation++;
      peer.owner.retire();
    }
    this.peers.clear();
    this.nonces.clear();
  }
  async close(): Promise<void> {
    this.retire();
    await Promise.allSettled([...this.jobs]);
    await this.lifetime.close();
  }
}
