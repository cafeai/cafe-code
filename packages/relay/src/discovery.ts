import type * as Schema from "effect/Schema";
import { LookupResult } from "./controls.ts";
import {
  verifyNetwork,
  relayHttpEndpoint,
  isLoopbackHost,
  type NetworkDescriptor,
  type RelayNode,
} from "./descriptor.ts";
import { parseRelayUrl, RelayError, requireRelay } from "./errors.ts";
import { epochNow, Lifetime } from "./lifetime.ts";
import { RELAY_LIMITS } from "./limits.ts";
import { canonicalBytes, readCanonical } from "./protocol.ts";

export type RelayFetch = (input: string, init: RequestInit) => Promise<Response>;

export async function readBoundedResponse(
  response: Response,
  maximum: number,
): Promise<Uint8Array> {
  requireRelay(response.ok && !response.redirected && response.body);
  const rawLength = response.headers.get("content-length");
  if (rawLength !== null)
    requireRelay(/^\d{1,10}$/.test(rawLength) && Number(rawLength) <= maximum);
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      requireRelay(length <= maximum);
      chunks.push(result.value);
    }
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function fetchCanonical<A>(
  fetcher: RelayFetch,
  lifetime: Lifetime,
  url: string,
  schema: Schema.Decoder<A>,
  maximum: number,
  request?: unknown,
): Promise<A> {
  const deadline = lifetime.deadline(RELAY_LIMITS.handshakeMs);
  try {
    const response = await fetcher(url, {
      method: request === undefined ? "GET" : "POST",
      ...(request === undefined
        ? {}
        : {
            body: canonicalBytes(request, maximum).slice(),
            headers: { "content-type": "application/json" },
          }),
      redirect: "error",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      signal: deadline.signal,
    });
    const bytes = await readBoundedResponse(response, maximum);
    requireRelay(lifetime.active && !deadline.signal.aborted, "UNAVAILABLE");
    return readCanonical(schema, bytes, maximum);
  } catch (error) {
    throw error instanceof RelayError ? error : new RelayError("UNAVAILABLE");
  } finally {
    deadline.cancel();
  }
}

export async function discoverNetwork(input: {
  readonly bootstrapUrls: readonly string[];
  readonly rootPublicKey: string;
  readonly minimumRevision?: number;
  readonly lifetime: Lifetime;
  readonly fetcher?: RelayFetch;
  readonly allowLoopbackTest?: boolean;
}): Promise<NetworkDescriptor> {
  requireRelay(input.bootstrapUrls.length >= 1 && input.bootstrapUrls.length <= 3);
  for (const endpoint of input.bootstrapUrls) {
    const url = parseRelayUrl(endpoint);
    requireRelay(
      !url.username && !url.password && !url.search && !url.hash && url.pathname === "/v1/network",
    );
    requireRelay(
      url.protocol === "https:" ||
        (input.allowLoopbackTest && url.protocol === "http:" && isLoopbackHost(url.hostname)),
    );
  }
  const owners = input.bootstrapUrls.map(() => new Lifetime());
  const retire = () => {
    for (const owner of owners) owner.retire();
  };
  input.lifetime.signal.addEventListener("abort", retire, { once: true });
  if (!input.lifetime.active) retire();
  const attempts = input.bootstrapUrls.map(async (endpoint, index) => {
    const owner = owners[index]!;
    requireRelay(owner.active, "UNAVAILABLE");
    const deadline = owner.deadline(RELAY_LIMITS.handshakeMs);
    try {
      const response = await (input.fetcher ?? fetch)(endpoint, {
        redirect: "error",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
        signal: deadline.signal,
      });
      const bytes = await readBoundedResponse(response, RELAY_LIMITS.descriptorBytes);
      requireRelay(owner.active && !deadline.signal.aborted, "UNAVAILABLE");
      return await verifyNetwork(bytes, {
        rootPublicKey: input.rootPublicKey,
        now: epochNow(),
        ...(input.minimumRevision === undefined ? {} : { minimumRevision: input.minimumRevision }),
        ...(input.allowLoopbackTest ? { allowLoopbackTest: true } : {}),
      });
    } finally {
      deadline.cancel();
    }
  });
  try {
    return await Promise.any(attempts);
  } catch {
    throw new RelayError("UNAVAILABLE");
  } finally {
    retire();
    input.lifetime.signal.removeEventListener("abort", retire);
    await Promise.allSettled(attempts);
    await Promise.all(owners.map((owner) => owner.close()));
  }
}

export async function lookupHost(input: {
  readonly network: NetworkDescriptor;
  readonly locator: string;
  readonly lifetime: Lifetime;
  readonly fetcher?: RelayFetch;
  readonly preferredNodeId?: string;
  readonly allowLoopbackTest?: boolean;
}): Promise<readonly { readonly node: RelayNode; readonly registrationId: string }[]> {
  const nodes = [...input.network.nodes]
    .sort((a, b) => Number(b.id === input.preferredNodeId) - Number(a.id === input.preferredNodeId))
    .slice(0, 3);
  for (const node of nodes) {
    try {
      const result = await fetchCanonical(
        input.fetcher ?? fetch,
        input.lifetime,
        relayHttpEndpoint(node, "/v1/lookup", input.allowLoopbackTest),
        LookupResult,
        RELAY_LIMITS.lookupResponseBytes,
        { networkId: input.network.networkId, locator: input.locator },
      );
      requireRelay(result.networkId === input.network.networkId, "NETWORK_MISMATCH");
      const candidates = result.candidates.map((candidate) => {
        const approved = input.network.nodes.find((member) => member.id === candidate.nodeId);
        requireRelay(approved, "NETWORK_MISMATCH");
        return {
          node: approved,
          registrationId: candidate.registrationId,
          priority: candidate.priority,
        };
      });
      requireRelay(
        new Set(candidates.map((candidate) => candidate.node.id)).size === candidates.length,
      );
      if (candidates.length)
        return candidates.sort(
          (a, b) =>
            a.priority - b.priority ||
            Number(b.node.id === input.preferredNodeId) -
              Number(a.node.id === input.preferredNodeId),
        );
    } catch {
      if (!input.lifetime.active) throw new RelayError("UNAVAILABLE");
    }
  }
  throw new RelayError("NOT_FOUND");
}
