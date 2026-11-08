import { deferred } from "./deferred.ts";
import { admissionProof } from "./broker.ts";
import { randomOpaque } from "./bytes.ts";
import { createIdentity, signBytes, type RelayIdentity } from "./crypto.ts";
import type { NetworkDescriptor, RelayNode } from "./descriptor.ts";
import { relayEndpoint } from "./descriptor.ts";
import { lookupHost, type RelayFetch } from "./discovery.ts";
import { RelayError, requireRelay } from "./errors.ts";
import { RelayLeg, type EndpointCircuit } from "./leg.ts";
import { Lifetime, epochNow } from "./lifetime.ts";
import { RELAY_LIMITS } from "./limits.ts";
import { OUTER, ZERO_CIRCUIT } from "./protocol.ts";
import { RelaySession } from "./session.ts";
import { relayResources, type PacketConnection, type RelayResources } from "./wire.ts";

export interface ViewerTicket {
  readonly nodeId: string;
  readonly registrationId: string;
  readonly token: string;
  readonly expiresAt: number;
  readonly admissionIdentity: RelayIdentity;
}
export interface ViewerTarget {
  readonly network: NetworkDescriptor;
  readonly hostPublicKey: string;
  readonly environmentId: string;
  readonly locator: string;
  readonly preferredNodeId: string;
  readonly deviceIdentity: RelayIdentity;
  readonly tickets: readonly ViewerTicket[];
  readonly paired: boolean;
}
export type RelayDial = (node: RelayNode, resources: RelayResources) => PacketConnection;

/**
 * Discovery/transport retries contain no pairing/password/OTP. The caller gets
 * one pinned, bound channel and explicitly performs its AUTH afterwards.
 */
export async function connectViewer(input: {
  readonly target: ViewerTarget;
  readonly dial: RelayDial;
  readonly lifetime: Lifetime;
  readonly fetcher?: RelayFetch;
  readonly allowLoopbackTest?: boolean;
  readonly resources?: RelayResources;
}): Promise<{
  readonly session: RelaySession;
  readonly close: () => Promise<void>;
  readonly nodeId: string;
  readonly registrationId: string;
  readonly admissionIdentity: RelayIdentity;
}> {
  const target = input.target;
  requireRelay(target.network.expiresAt > epochNow(), "EXPIRED");
  const resources = input.resources ?? relayResources();
  const candidates = await lookupHost({
    network: target.network,
    locator: target.locator,
    lifetime: input.lifetime,
    ...(input.fetcher ? { fetcher: input.fetcher } : {}),
    preferredNodeId: target.preferredNodeId,
    ...(input.allowLoopbackTest ? { allowLoopbackTest: true } : {}),
  });
  const attempts = candidates.flatMap((candidate) => {
    const ticket = target.tickets.find(
      (value) =>
        value.nodeId === candidate.node.id &&
        value.registrationId === candidate.registrationId &&
        value.expiresAt > epochNow(),
    );
    const first = { ...candidate, ticket };
    return ticket && target.paired ? [first, { ...candidate, ticket: undefined }] : [first];
  });
  for (const candidate of attempts) {
    const ticket = candidate.ticket;
    if (!ticket && !target.paired) continue;
    relayEndpoint(candidate.node.url, input.allowLoopbackTest);
    let connection: PacketConnection | undefined;
    const abort = () => connection?.retire();
    input.lifetime.signal.addEventListener("abort", abort, { once: true });
    try {
      requireRelay(input.lifetime.active, "UNAVAILABLE");
      connection = input.dial(candidate.node, resources);
      const leg = new RelayLeg(connection, resources, target.network.networkId, candidate.node.id);
      const offered = deferred<EndpointCircuit>();
      void offered.promise.catch(() => {});
      connection.lifetime.signal.addEventListener(
        "abort",
        () => offered.reject(new RelayError("UNAVAILABLE")),
        { once: true },
      );
      leg.onOffer((id, offer) => {
        requireRelay(
          offer.locator === target.locator &&
            offer.registrationId === candidate.registrationId &&
            offer.viewerCircuitNonce === nonce &&
            offer.admissionPublicKey === admission.publicKey &&
            offer.recovery === !ticket,
        );
        offered.resolve(leg.circuit(id, offer, "viewer"));
      });
      const admission = ticket?.admissionIdentity ?? (await createIdentity()),
        nonce = randomOpaque(16);
      const hello = await leg.hello;
      const unsigned = {
        locator: target.locator,
        registrationId: candidate.registrationId,
        viewerCircuitNonce: nonce,
        admissionPublicKey: admission.publicKey,
        ticket: ticket?.token ?? null,
        recovery: !ticket,
      };
      const signature = await signBytes(admission, admissionProof(hello, unsigned));
      requireRelay(input.lifetime.active && connection.active, "UNAVAILABLE");
      leg.send(OUTER.ATTACH, ZERO_CIRCUIT, { ...unsigned, signature });
      const cancel = connection.lifetime.later(RELAY_LIMITS.handshakeMs, () =>
        offered.reject(new RelayError("UNAVAILABLE")),
      );
      const circuit = await offered.promise.finally(cancel);
      const session = await RelaySession.open({
        circuit,
        identity: target.deviceIdentity,
        direction: "viewer",
        expectedHostKey: target.hostPublicKey,
      });
      await session.bound;
      requireRelay(input.lifetime.active && connection.active && session.active, "UNAVAILABLE");
      const held = connection;
      void session.closed.then(() => held.retire());
      return {
        session,
        nodeId: candidate.node.id,
        registrationId: candidate.registrationId,
        admissionIdentity: admission,
        close: async () => {
          input.lifetime.signal.removeEventListener("abort", abort);
          await session.close();
          await held.close();
        },
      };
    } catch (error) {
      input.lifetime.signal.removeEventListener("abort", abort);
      await connection?.close();
      if (!input.lifetime.active) throw new RelayError("UNAVAILABLE");
      // A host-key/context failure is terminal, never a downgrade/fallback signal.
      if (
        error instanceof RelayError &&
        ["HOST_IDENTITY_MISMATCH", "NETWORK_MISMATCH", "CRYPTO_FAILURE"].includes(error.code)
      )
        throw error;
    }
  }
  throw new RelayError("UNAVAILABLE");
}
