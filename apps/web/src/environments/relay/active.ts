import { connectViewer } from "@cafecode/relay/client";
import { connectBrowser } from "@cafecode/relay/browserWire";
import { discoverNetwork } from "@cafecode/relay/discovery";
import { fetchRelayed } from "@cafecode/relay/http";
import { RelayError } from "@cafecode/relay/errors";
import { Lifetime } from "@cafecode/relay/lifetime";
import type { NetworkDescriptor } from "@cafecode/relay/descriptor";
import { privateIdentityBytes, restoreIdentity, type RelayIdentity } from "@cafecode/relay/crypto";
import { opaque, unopaqueBounded } from "@cafecode/relay/bytes";
import { epochNow } from "@cafecode/relay/lifetime";
import { RELAY_LIMITS } from "@cafecode/relay/limits";
import { saveRelayTarget } from "./storage";
import type { RelaySession } from "@cafecode/relay/session";
import { RelayWebSocket } from "./socket";

export interface SavedRelayTarget {
  readonly id: string;
  readonly networkId: string;
  readonly rootPublicKey: string;
  readonly bootstrapUrls: readonly string[];
  readonly minimumRevision: number;
  readonly hostPublicKey: string;
  readonly environmentId: string;
  readonly locator: string;
  readonly preferredNodeId: string;
  readonly bearerToken: string;
  readonly tickets?: readonly SavedRelayTicket[];
}
export interface SavedRelayTicket {
  readonly nodeId: string;
  readonly registrationId: string;
  readonly token: string;
  readonly expiresAt: number;
  readonly admissionPrivateKey: string;
}
export function savedTransportTickets(
  connection: Awaited<ReturnType<typeof connectViewer>>,
): readonly SavedRelayTicket[] {
  return (connection.session.auth?.transportTickets ?? []).map((ticket) => {
    if (
      ticket.nodeId !== connection.nodeId ||
      ticket.registrationId !== connection.registrationId ||
      ticket.admissionPublicKey !== connection.admissionIdentity.publicKey ||
      ticket.expiresAt <= epochNow() ||
      ticket.expiresAt > epochNow() + RELAY_LIMITS.ticketMs + RELAY_LIMITS.clockSkewMs
    )
      throw new RelayError("PROTOCOL_ERROR");
    return {
      nodeId: ticket.nodeId,
      registrationId: ticket.registrationId,
      token: ticket.token,
      expiresAt: ticket.expiresAt,
      admissionPrivateKey: opaque(privateIdentityBytes(connection.admissionIdentity)),
    };
  });
}
let primary: ActiveRelay | undefined;
const saved = new Map<string, ActiveRelay>();
const suffix = ".cafecode-relay.invalid";
export function savedRelayUrls(id: string) {
  return {
    httpBaseUrl: "https://" + id.toLowerCase() + suffix + "/",
    wsBaseUrl: "wss://" + id.toLowerCase() + suffix + "/",
  };
}
export class ActiveRelay {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  private record: SavedRelayTarget;
  private readonly identity: RelayIdentity;
  private readonly lifetime = new Lifetime();
  private current: Awaited<ReturnType<typeof connectViewer>> | undefined;
  private acquiring: Promise<RelaySession> | undefined;
  private closing: Promise<void> | undefined;
  private readonly initialLifetime: Lifetime | undefined;
  constructor(
    record: SavedRelayTarget,
    identity: RelayIdentity,
    initial?: Awaited<ReturnType<typeof connectViewer>>,
    initialLifetime?: Lifetime,
    private readonly persist = saveRelayTarget,
  ) {
    this.record = record;
    this.identity = identity;
    this.current = initial;
    this.initialLifetime = initialLifetime;
    const urls = savedRelayUrls(record.id);
    this.httpBaseUrl = urls.httpBaseUrl;
    this.wsBaseUrl = urls.wsBaseUrl;
  }
  session(): Promise<RelaySession> {
    if (!this.lifetime.active) return Promise.reject(new RelayError("UNAVAILABLE"));
    if (this.current?.session.active) return Promise.resolve(this.current.session);
    if (this.acquiring) return this.acquiring;
    const job = this.resume();
    this.acquiring = job;
    void job.then(
      () => {
        if (this.acquiring === job) this.acquiring = undefined;
      },
      () => {
        if (this.acquiring === job) this.acquiring = undefined;
      },
    );
    return job;
  }
  private async resume(): Promise<RelaySession> {
    await this.current?.close();
    const network: NetworkDescriptor = await discoverNetwork({
      bootstrapUrls: this.record.bootstrapUrls,
      rootPublicKey: this.record.rootPublicKey,
      minimumRevision: this.record.minimumRevision,
      lifetime: this.lifetime,
    });
    const tickets = (this.record.tickets ?? [])
      .filter((ticket) => ticket.expiresAt > epochNow())
      .map((ticket) => ({
        ...ticket,
        admissionIdentity: restoreIdentity(unopaqueBounded(ticket.admissionPrivateKey, 128)),
      }));
    // Reserve local one-use capacity before dialing. A lost outer response may
    // use bounded recovery, while the saved application credential stays fixed.
    this.record = {
      ...this.record,
      tickets: [],
      minimumRevision: Math.max(this.record.minimumRevision, network.revision),
    };
    await this.persist(this.record, this.identity, this.lifetime.signal);
    const connection = await connectViewer({
      target: {
        network,
        hostPublicKey: this.record.hostPublicKey,
        environmentId: this.record.environmentId,
        locator: this.record.locator,
        preferredNodeId: this.record.preferredNodeId,
        deviceIdentity: this.identity,
        tickets,
        paired: true,
      },
      dial: (node, resources) => connectBrowser(node.url, resources),
      lifetime: this.lifetime,
    });
    try {
      const auth = await connection.session.authenticate({
        environmentId: this.record.environmentId,
        operation: "resume",
        credential: this.record.bearerToken,
      });
      if (!this.lifetime.active || auth.environmentId !== this.record.environmentId)
        throw new RelayError("ENVIRONMENT_MISMATCH");
      this.record = {
        ...this.record,
        preferredNodeId: connection.nodeId,
        tickets: savedTransportTickets(connection),
      };
      await this.persist(this.record, this.identity, this.lifetime.signal);
      if (!this.lifetime.active) throw new RelayError("UNAVAILABLE");
      this.current = connection;
      return connection.session;
    } catch (error) {
      await connection.close();
      throw error;
    }
  }
  async request(path: string, init?: RequestInit): Promise<Response> {
    return fetchRelayed(await this.session(), path, init);
  }
  socket(url: string): WebSocket {
    return new RelayWebSocket(url, () => this.session());
  }
  retire(): void {
    const hostname = new URL(this.httpBaseUrl).hostname;
    if (saved.get(hostname) === this) saved.delete(hostname);
    this.lifetime.retire();
    this.initialLifetime?.retire();
  }
  close(): Promise<void> {
    this.retire();
    return (this.closing ??= (async () => {
      await Promise.allSettled([this.current?.close(), this.acquiring]);
      await Promise.all([this.lifetime.close(), this.initialLifetime?.close()]);
    })());
  }
  get environmentId(): string {
    return this.record.environmentId;
  }
  matches(record: SavedRelayTarget, identity: RelayIdentity): boolean {
    return (
      this.lifetime.active &&
      this.identity.publicKey === identity.publicKey &&
      this.record.id === record.id &&
      this.record.networkId === record.networkId &&
      this.record.environmentId === record.environmentId &&
      this.record.rootPublicKey === record.rootPublicKey &&
      this.record.hostPublicKey === record.hostPublicKey &&
      this.record.locator === record.locator &&
      this.record.bearerToken === record.bearerToken
    );
  }
}
export function readSavedRelay(url: string): ActiveRelay | undefined {
  return saved.get(new URL(url).hostname);
}
export function installSavedRelay(relay: ActiveRelay): void {
  const hostname = new URL(relay.httpBaseUrl).hostname;
  if (saved.get(hostname) === relay) return;
  if (saved.has(hostname) || saved.size >= 64) throw new RelayError("BUSY");
  saved.set(hostname, relay);
}
export async function installPrimaryRelay(relay: ActiveRelay): Promise<void> {
  const previous = primary;
  primary = relay;
  if (previous && previous !== relay) await previous.close();
}
export function readPrimaryRelay(): ActiveRelay | undefined {
  return primary;
}
export function relayForUrl(input: string | URL): ActiveRelay | undefined {
  const url = new URL(input);
  if (!url.hostname.endsWith(suffix)) return undefined;
  const relay =
    primary && new URL(primary.httpBaseUrl).hostname === url.hostname
      ? primary
      : saved.get(url.hostname);
  if (!relay || url.username || url.password) throw new RelayError("UNAVAILABLE");
  return relay;
}
/** Explicit target dependency injection; never patches global fetch/WebSocket. */
export const fetchAppResource: typeof globalThis.fetch = async (input, init) => {
  if (!primary) {
    const absolute = input instanceof Request ? input.url : input.toString();
    if (URL.canParse(absolute) && new URL(absolute).hostname.endsWith(suffix)) {
      if (input instanceof Request) throw new RelayError("PROTOCOL_ERROR");
      const url = new URL(absolute);
      return relayForUrl(url)!.request(url.pathname + url.search, init);
    }
    return init === undefined ? fetch(input) : fetch(input, init);
  }
  const url =
    input instanceof Request
      ? new URL(input.url)
      : new URL(input, typeof window === "undefined" ? undefined : window.location?.origin);
  if (
    primary &&
    typeof input === "string" &&
    input.startsWith("/") &&
    !input.startsWith("//") &&
    (url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/attachments/") ||
      url.pathname === "/.well-known/cafe-code/environment")
  )
    return primary.request(url.pathname + url.search, init);
  const relay = relayForUrl(url);
  if (!relay) return init === undefined ? fetch(input) : fetch(input, init);
  if (input instanceof Request) throw new RelayError("PROTOCOL_ERROR");
  return relay.request(url.pathname + url.search, init);
};
export function makeAppWebSocket(url: string | URL, protocols?: string | string[]): WebSocket {
  return relayForUrl(url)?.socket(url.toString()) ?? new WebSocket(url, protocols);
}
