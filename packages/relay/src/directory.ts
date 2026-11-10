import type { DirectoryRecord, DirectorySnapshot, LookupResult } from "./controls.ts";
import type { NetworkDescriptor } from "./descriptor.ts";
import { requireRelay } from "./errors.ts";
import { RELAY_LIMITS } from "./limits.ts";

interface Observation {
  readonly owner: object;
  readonly bootId: string;
  readonly sequence: number;
  readonly receivedAt: number;
  readonly records: readonly DirectoryRecord[];
}

/** Each peer publishes only its own records. There is no quorum or forwarding. */
export class RelayDirectory {
  private network: NetworkDescriptor;
  private readonly observations = new Map<string, Observation>();
  private readonly owners = new Map<string, object>();

  constructor(network: NetworkDescriptor) {
    this.network = network;
  }
  update(network: NetworkDescriptor): void {
    requireRelay(
      network.networkId === this.network.networkId &&
        network.rootPublicKey === this.network.rootPublicKey &&
        network.revision > this.network.revision,
      "NETWORK_MISMATCH",
    );
    this.network = network;
    for (const nodeId of this.owners.keys())
      if (!network.nodes.some((node) => node.id === nodeId)) {
        this.owners.delete(nodeId);
        this.observations.delete(nodeId);
      }
  }

  begin(nodeId: string): {
    readonly publish: (snapshot: DirectorySnapshot, now: number) => boolean;
    readonly retire: () => void;
  } {
    requireRelay(
      this.network.nodes.some((node) => node.id === nodeId),
      "NETWORK_MISMATCH",
    );
    const owner = {};
    this.owners.set(nodeId, owner);
    // Old observations do not survive a newly authenticated peer incarnation.
    this.observations.delete(nodeId);
    return {
      publish: (snapshot, now) => {
        if (this.owners.get(nodeId) !== owner) return false;
        requireRelay(
          snapshot.networkId === this.network.networkId && snapshot.nodeId === nodeId,
          "NETWORK_MISMATCH",
        );
        const previous = this.observations.get(nodeId);
        if (previous?.bootId === snapshot.bootId && snapshot.sequence <= previous.sequence)
          return false;
        requireRelay(snapshot.records.length <= RELAY_LIMITS.registrations);
        const locators = new Set<string>();
        for (const record of snapshot.records) {
          requireRelay(!locators.has(record.locator));
          requireRelay(record.expiresAt <= now + RELAY_LIMITS.leaseMs + RELAY_LIMITS.clockSkewMs);
          locators.add(record.locator);
        }
        this.observations.set(nodeId, {
          owner,
          bootId: snapshot.bootId,
          sequence: snapshot.sequence,
          receivedAt: now,
          records: snapshot.records.filter((record) => record.expiresAt > now),
        });
        return true;
      },
      retire: () => {
        if (this.owners.get(nodeId) !== owner) return;
        this.owners.delete(nodeId);
        this.observations.delete(nodeId);
      },
    };
  }

  lookup(locator: string, now: number): LookupResult {
    const candidates: Array<{ nodeId: string; registrationId: string; priority: 0 | 1 }> = [];
    for (const node of this.network.nodes) {
      const observation = this.observations.get(node.id);
      if (!observation || now - observation.receivedAt >= RELAY_LIMITS.leaseMs) continue;
      const record = observation.records.find(
        (value) => value.locator === locator && value.expiresAt > now,
      );
      if (record)
        candidates.push({
          nodeId: node.id,
          registrationId: record.registrationId,
          priority: record.priority,
        });
      if (candidates.length === 3) break;
    }
    return {
      networkId: this.network.networkId,
      candidates: candidates.sort((a, b) => a.priority - b.priority),
    };
  }

  get size(): number {
    let count = 0;
    for (const observation of this.observations.values()) count += observation.records.length;
    return count;
  }
}
