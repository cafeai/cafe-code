import type { RelayIdentity } from "./crypto.ts";
import type { NetworkDescriptor, RelayNode } from "./descriptor.ts";
import { relayEndpoint } from "./descriptor.ts";
import { RelayError, requireRelay } from "./errors.ts";
import { RelayLeg } from "./leg.ts";
import { epochNow, Lifetime } from "./lifetime.ts";
import { RELAY_LIMITS } from "./limits.ts";
import { OUTER } from "./protocol.ts";
import { RelaySession, type SessionHandlers } from "./session.ts";
import { relayResources, type PacketConnection, type RelayResources } from "./wire.ts";
import type { RelayDial } from "./client.ts";
import * as Schema from "effect/Schema";
import { fetchCanonical } from "./discovery.ts";
import { relayHttpEndpoint } from "./descriptor.ts";
import { monotonicMillis } from "./lifetime.ts";
import { selectHostRelays, type RelayObservation } from "./selection.ts";
import { type HostReservation, type HostWorkClient, type HostWorkScope } from "./hostWork.ts";

const LatencyResponse = Schema.Struct({ version: Schema.Literal(1) });

export interface HostNodeCredential {
  readonly nodeId: string;
  readonly locator: string;
  readonly token: string;
  readonly admissionIdentity: RelayIdentity;
}
interface ServingNode {
  readonly node: RelayNode;
  readonly connection: PacketConnection;
  readonly leg: RelayLeg;
  readonly registrationId: string;
  readonly openedAt: number;
}

/** Outbound-only host endpoint. Losing a transport never stops Cafe work. */
export class RelayHost {
  readonly resources: RelayResources;
  private readonly lifetime = new Lifetime(() => this.retire());
  private readonly network: NetworkDescriptor;
  private readonly identity: RelayIdentity;
  private readonly credentials: readonly HostNodeCredential[];
  private readonly dial: RelayDial;
  private readonly handlers: SessionHandlers;
  private readonly work: HostWorkClient;
  private readonly reservations = new Map<string, HostReservation>();
  private readonly workJobs = new Set<Promise<void>>();
  private readonly renewing = new Set<string>();
  private readonly allowLoopbackTest: boolean;
  private readonly serving = new Map<string, ServingNode>();
  private readonly acquiring = new Set<string>();
  private readonly connections = new Set<PacketConnection>();
  private readonly sessions = new Set<RelaySession>();
  private pendingHandshakes = 0;
  private readonly openings = new Set<Promise<void>>();
  private primaryNodeId: string | undefined;
  private readonly observations = new Map<string, RelayObservation>();
  private lastProbe = 0;
  private probeCursor = 0;
  private reconciling: Promise<void> | undefined;
  private readonly measure: (node: RelayNode, lifetime: Lifetime) => Promise<number>;

  constructor(input: {
    readonly network: NetworkDescriptor;
    readonly identity: RelayIdentity;
    readonly credentials: readonly HostNodeCredential[];
    readonly dial: RelayDial;
    readonly handlers: SessionHandlers;
    readonly work: HostWorkClient;
    readonly allowLoopbackTest?: boolean;
    readonly resources?: RelayResources;
    readonly measureLatency?: (node: RelayNode, lifetime: Lifetime) => Promise<number>;
  }) {
    requireRelay(input.credentials.length >= 1 && input.credentials.length <= RELAY_LIMITS.members);
    this.network = input.network;
    this.identity = input.identity;
    this.credentials = input.credentials;
    this.dial = input.dial;
    this.handlers = input.handlers;
    this.work = input.work;
    this.allowLoopbackTest = input.allowLoopbackTest ?? false;
    this.resources = input.resources ?? relayResources();
    this.measure =
      input.measureLatency ??
      (async (node, lifetime) => {
        const start = monotonicMillis();
        await fetchCanonical(
          fetch,
          lifetime,
          relayHttpEndpoint(node, "/v1/latency", this.allowLoopbackTest),
          LatencyResponse,
          1024,
        );
        return Math.max(0, monotonicMillis() - start);
      });
  }
  async start(): Promise<void> {
    await this.reconcile();
    this.tick();
  }
  private tick(): void {
    this.lifetime.later(5_000, () => {
      this.renewReservations();
      void this.reconcile()
        .catch(() => {})
        .finally(() => {
          if (this.lifetime.active) this.tick();
        });
    });
  }

  private reconcile(): Promise<void> {
    if (this.reconciling) return this.reconciling;
    const job = this.performReconcile();
    this.reconciling = job;
    void job.then(
      () => {
        if (this.reconciling === job) this.reconciling = undefined;
      },
      () => {
        if (this.reconciling === job) this.reconciling = undefined;
      },
    );
    return job;
  }
  private async performReconcile(): Promise<void> {
    if (!this.lifetime.active || this.network.expiresAt <= epochNow()) {
      this.retire();
      return;
    }
    const eligible = this.network.nodes.filter((node) =>
      this.credentials.some((credential) => credential.nodeId === node.id),
    );
    if (epochNow() - this.lastProbe >= 60_000 || this.lastProbe === 0) {
      this.lastProbe = epochNow();
      const sample = Array.from(
        { length: Math.min(3, eligible.length) },
        (_, index) => eligible[(this.probeCursor + index) % eligible.length]!,
      );
      this.probeCursor = (this.probeCursor + sample.length) % Math.max(1, eligible.length);
      for (let offset = 0; offset < sample.length; offset += 2)
        await Promise.allSettled(
          sample.slice(offset, offset + 2).map(async (node) => {
            try {
              const rtt = await this.measure(node, this.lifetime);
              requireRelay(Number.isFinite(rtt) && rtt >= 0 && this.lifetime.active);
              const old = this.observations.get(node.id);
              this.observations.set(node.id, {
                nodeId: node.id,
                rtt: old ? old.rtt * 0.75 + rtt * 0.25 : rtt,
                measuredAt: epochNow(),
              });
            } catch {
              if (!this.serving.has(node.id)) this.observations.delete(node.id);
            }
          }),
        );
    }
    const desired = selectHostRelays(
      eligible,
      [...this.observations.values()],
      this.primaryNodeId && this.serving.has(this.primaryNodeId) ? this.primaryNodeId : undefined,
      epochNow(),
    );
    this.primaryNodeId = desired[0]?.id;
    const ordered = [...desired, ...eligible.filter((node) => !desired.includes(node))];
    for (const node of ordered) {
      if (!desired.some((value) => !this.serving.has(value.id)) && this.serving.size >= 2) break;
      if (this.serving.size + this.acquiring.size >= 3) break;
      const credential = this.credentials.find((value) => value.nodeId === node.id);
      if (!credential || this.serving.has(node.id) || this.acquiring.has(node.id)) continue;
      this.acquiring.add(node.id);
      try {
        await this.open(node, credential);
      } catch {
        /* Next approved node remains eligible. */
      } finally {
        this.acquiring.delete(node.id);
      }
    }
    if (!this.lifetime.active) return;
    const live = desired.filter((node) => this.serving.has(node.id));
    if (live.length < Math.min(2, eligible.length))
      for (const entry of this.serving.values())
        if (!live.some((node) => node.id === entry.node.id)) live.push(entry.node);
    this.primaryNodeId = live[0]?.id;
    for (const [id, entry] of this.serving) {
      if (live.slice(0, 2).some((node) => node.id === id))
        entry.leg.setPriority(id === this.primaryNodeId ? 0 : 1);
      else entry.connection.retire();
    }
    for (const [id, reservation] of this.reservations) {
      if (this.serving.has(id) || desired.some((node) => node.id === id)) continue;
      this.reservations.delete(id);
      const node = this.network.nodes.find((node) => node.id === id);
      const credential = this.credentials.find((value) => value.nodeId === id);
      if (node && credential) this.releaseReservation(node, credential, reservation);
    }
  }

  private workScope(node: RelayNode, credential: HostNodeCredential): HostWorkScope {
    return {
      network: this.network,
      node,
      locator: credential.locator,
      capacityToken: credential.token,
      admissionIdentity: credential.admissionIdentity,
      allowLoopbackTest: this.allowLoopbackTest,
    };
  }
  private releaseReservation(
    node: RelayNode,
    credential: HostNodeCredential,
    reservation: HostReservation,
  ) {
    const job = Promise.resolve()
      .then(() => this.work.release(this.workScope(node, credential), reservation))
      .catch(() => {})
      .finally(() => this.workJobs.delete(job));
    this.workJobs.add(job);
  }
  private renewReservations() {
    if (!this.lifetime.active) return;
    for (const [id, entry] of this.serving) {
      const previous = this.reservations.get(id),
        credential = this.credentials.find((value) => value.nodeId === id);
      if (!previous || !credential || this.renewing.has(id) || previous.renewAt > epochNow())
        continue;
      this.renewing.add(id);
      const job = this.work
        .acquire(this.workScope(entry.node, credential), this.lifetime, previous, true)
        .then((reservation) => {
          if (
            this.lifetime.active &&
            this.reservations.get(id) === previous &&
            this.serving.get(id) === entry
          )
            this.reservations.set(id, reservation);
        })
        .catch(() => {
          if (this.serving.get(id) === entry && previous.expiresAt <= epochNow())
            entry.connection.retire();
        })
        .finally(() => {
          this.renewing.delete(id);
          this.workJobs.delete(job);
        });
      this.workJobs.add(job);
    }
  }

  private async open(node: RelayNode, credential: HostNodeCredential): Promise<void> {
    relayEndpoint(node.url, this.allowLoopbackTest);
    requireRelay(this.lifetime.active, "UNAVAILABLE");
    const reservation = await this.work.acquire(
      this.workScope(node, credential),
      this.lifetime,
      this.reservations.get(node.id),
    );
    requireRelay(this.lifetime.active, "UNAVAILABLE");
    this.reservations.set(node.id, reservation);
    const connection = this.dial(node, this.resources);
    this.connections.add(connection);
    const leg = new RelayLeg(connection, this.resources, this.network.networkId, node.id);
    connection.lifetime.signal.addEventListener(
      "abort",
      () => {
        const current = this.serving.get(node.id);
        if (current?.connection === connection) this.serving.delete(node.id);
      },
      { once: true },
    );
    void connection.closed.then(() => this.connections.delete(connection));
    leg.onOffer((id, offer) => {
      requireRelay(
        this.lifetime.active &&
          offer.locator === credential.locator &&
          this.serving.get(node.id)?.connection === connection &&
          this.serving.get(node.id)?.registrationId === offer.registrationId,
      );
      if (this.pendingHandshakes >= RELAY_LIMITS.hostPendingHandshakes) {
        leg.send(OUTER.CLOSE, id, {});
        return;
      }
      const circuit = leg.circuit(id, offer, "host");
      const jobOwner = this.resources.owners.reserve();
      if (!jobOwner) {
        circuit.retire();
        return;
      }
      this.pendingHandshakes++;
      circuit.accept();
      let heldPreauth = true;
      const releasePreauth = () => {
        if (!heldPreauth) return;
        heldPreauth = false;
        this.pendingHandshakes--;
      };
      const ownedHandlers: SessionHandlers = {
        authenticate: async (auth, devicePublicKey) => {
          requireRelay(!offer.recovery || auth.operation === "resume", "AUTH_REJECTED");
          requireRelay(this.handlers.authenticate);
          return this.handlers.authenticate(auth, devicePublicKey);
        },
        ...(this.handlers.open ? { open: this.handlers.open } : {}),
        ...(this.handlers.validate ? { validate: this.handlers.validate } : {}),
        tickets: async () => {
          const issued = await leg.mintTickets(
            offer.registrationId,
            "resume",
            offer.admissionPublicKey,
            4,
            2_000,
          );
          return issued.tickets.map((ticket) => ({
            ...ticket,
            nodeId: node.id,
            registrationId: offer.registrationId,
            admissionPublicKey: offer.admissionPublicKey,
          }));
        },
      };
      let adopted = false;
      const opening = RelaySession.open({
        circuit,
        direction: "host",
        identity: this.identity,
        handlers: ownedHandlers,
      })
        .then(async (opened) => {
          if (!this.lifetime.active || !connection.active) {
            await opened.close();
            return;
          }
          adopted = true;
          this.sessions.add(opened);
          void opened.authorized.then(releasePreauth, () => {});
          void opened.closed
            .then(() => opened.close())
            .then(() => {
              releasePreauth();
              this.sessions.delete(opened);
              jobOwner();
            })
            .catch(() => this.retire());
        })
        .catch(() => {
          circuit.retire();
          releasePreauth();
        })
        .finally(() => {
          this.openings.delete(opening);
          if (!adopted) jobOwner();
        });
      this.openings.add(opening);
      // Crypto and app-auth admission have distinct bounds. The circuit owns
      // its unauthenticated deadline independently of provider/session work.
    });
    try {
      const hello = await leg.hello;
      if (hello.bootId !== reservation.bootId) {
        this.reservations.delete(node.id);
        throw new RelayError("EXPIRED");
      }
      const registered = await leg.register(
        credential.locator,
        credential.token,
        credential.admissionIdentity,
        node.id === this.primaryNodeId ? 0 : 1,
        reservation.credential,
      );
      requireRelay(this.lifetime.active && connection.active, "UNAVAILABLE");
      this.serving.set(node.id, {
        node,
        connection,
        leg,
        registrationId: registered.registrationId,
        openedAt: epochNow(),
      });
    } catch {
      await connection.close();
      throw new RelayError("UNAVAILABLE");
    }
  }

  async invitationTicket(): Promise<{
    readonly node: RelayNode;
    readonly registrationId: string;
    readonly token: string;
    readonly expiresAt: number;
  }> {
    const primary =
      (this.primaryNodeId ? this.serving.get(this.primaryNodeId) : undefined) ??
      this.serving.values().next().value;
    requireRelay(primary && primary.connection.active, "UNAVAILABLE");
    const result = await primary.leg.mintTickets(primary.registrationId, "invite", null);
    const ticket = result.tickets[0];
    requireRelay(ticket && this.serving.get(primary.node.id) === primary, "UNAVAILABLE");
    return { node: primary.node, registrationId: primary.registrationId, ...ticket };
  }
  retire(): void {
    this.lifetime.retire();
    for (const session of this.sessions) session.retire();
    for (const connection of this.connections) connection.retire();
  }
  async close(): Promise<void> {
    const held = [...this.connections];
    this.retire();
    await Promise.all(held.map((connection) => connection.close()));
    await this.reconciling?.catch(() => {});
    await Promise.all(this.workJobs);
    for (const [id, reservation] of this.reservations) {
      const node = this.network.nodes.find((node) => node.id === id),
        credential = this.credentials.find((value) => value.nodeId === id);
      if (node && credential) this.releaseReservation(node, credential, reservation);
    }
    this.reservations.clear();
    await Promise.all(this.workJobs);
    await Promise.all(this.openings);
    await Promise.all([...this.sessions].map((session) => session.close()));
    await this.lifetime.close();
  }
  stats(): {
    readonly servingNodes: readonly string[];
    readonly pendingHandshakes: number;
    readonly sessions: number;
  } {
    return {
      servingNodes: [...this.serving.keys()].sort(
        (a, b) => Number(b === this.primaryNodeId) - Number(a === this.primaryNodeId),
      ),
      pendingHandshakes: this.pendingHandshakes,
      sessions: this.sessions.size,
    };
  }
}
