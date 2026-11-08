import * as Schema from "effect/Schema";
import { deriveIdentityId, signBytes, verifyBytes, type RelayIdentity } from "./crypto.ts";
import { concatenate, unopaque, utf8 } from "./bytes.ts";
import { parseRelayUrl, requireRelay } from "./errors.ts";
import { RELAY_LIMITS } from "./limits.ts";
import { Id32, SafeCounter, canonicalBytes, readCanonical } from "./protocol.ts";

const Endpoint = Schema.String.check(Schema.isMaxLength(256));
export const RelayNode = Schema.Struct({ id: Id32, publicKey: Id32, url: Endpoint });
export type RelayNode = typeof RelayNode.Type;
export const NetworkDescriptor = Schema.Struct({
  version: Schema.Literal(1),
  networkId: Id32,
  rootPublicKey: Id32,
  revision: SafeCounter,
  expiresAt: SafeCounter,
  nodes: Schema.Array(RelayNode).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(RELAY_LIMITS.members),
  ),
  signature: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{86}$/)),
});
export type NetworkDescriptor = typeof NetworkDescriptor.Type;
const domain = utf8.encode("CafeCode/relay/descriptor/v1\0");

export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

/** An explicit local fixture may use WS; ordinary configuration always uses WSS. */
export function relayEndpoint(value: string, allowLoopbackTest = false): URL {
  requireRelay(value.length <= 256);
  const url = parseRelayUrl(value);
  requireRelay(
    url.protocol === "wss:" ||
      (allowLoopbackTest && url.protocol === "ws:" && isLoopbackHost(url.hostname)),
  );
  requireRelay(
    !url.username && !url.password && !url.search && !url.hash && url.pathname === "/v1/relay",
  );
  requireRelay(url.href === value);
  return url;
}

export function relayHttpEndpoint(
  node: RelayNode,
  pathname: "/v1/network" | "/v1/lookup" | "/v1/latency" | "/v1/mesh",
  allowLoopbackTest = false,
): string {
  const url = relayEndpoint(node.url, allowLoopbackTest);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = pathname;
  return url.href;
}

export async function signNetwork(input: {
  readonly root: RelayIdentity;
  readonly nodes: readonly RelayNode[];
  readonly revision: number;
  readonly expiresAt: number;
}): Promise<NetworkDescriptor> {
  const unsigned = {
    version: 1 as const,
    networkId: deriveIdentityId("network", input.root.publicKey),
    rootPublicKey: input.root.publicKey,
    revision: input.revision,
    expiresAt: input.expiresAt,
    nodes: input.nodes,
  };
  const bytes = canonicalBytes(unsigned, RELAY_LIMITS.descriptorBytes);
  return { ...unsigned, signature: await signBytes(input.root, concatenate(domain, bytes)) };
}

export async function verifyNetwork(
  bytes: Uint8Array,
  input: {
    readonly rootPublicKey: string;
    readonly now: number;
    readonly minimumRevision?: number;
    readonly allowLoopbackTest?: boolean;
  },
): Promise<NetworkDescriptor> {
  const descriptor = readCanonical(NetworkDescriptor, bytes, RELAY_LIMITS.descriptorBytes);
  requireRelay(descriptor.rootPublicKey === input.rootPublicKey, "NETWORK_MISMATCH");
  requireRelay(
    descriptor.networkId === deriveIdentityId("network", input.rootPublicKey),
    "NETWORK_MISMATCH",
  );
  requireRelay(Number.isFinite(input.now) && descriptor.expiresAt > input.now, "EXPIRED");
  requireRelay(descriptor.revision >= (input.minimumRevision ?? 0), "NETWORK_MISMATCH");
  const ids = new Set<string>(),
    endpoints = new Set<string>();
  for (const node of descriptor.nodes) {
    unopaque(node.publicKey, 32);
    requireRelay(node.id === deriveIdentityId("node", node.publicKey), "NETWORK_MISMATCH");
    requireRelay(!ids.has(node.id) && !endpoints.has(node.url));
    relayEndpoint(node.url, input.allowLoopbackTest);
    ids.add(node.id);
    endpoints.add(node.url);
  }
  const { signature, ...unsigned } = descriptor;
  requireRelay(
    await verifyBytes(
      input.rootPublicKey,
      concatenate(domain, canonicalBytes(unsigned, RELAY_LIMITS.descriptorBytes)),
      signature,
    ),
    "NETWORK_MISMATCH",
  );
  return descriptor;
}
