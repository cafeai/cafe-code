import { EnvironmentId, type ExecutionEnvironmentDescriptor } from "@cafecode/contracts";
import { parseInvitationUrl } from "@cafecode/relay/invitation";
import { connectViewer } from "@cafecode/relay/client";
import { connectBrowser } from "@cafecode/relay/browserWire";
import { createIdentity, sha256 } from "@cafecode/relay/crypto";
import { concatenate, opaque, unopaque, utf8 } from "@cafecode/relay/bytes";
import { discoverNetwork, readBoundedResponse } from "@cafecode/relay/discovery";
import { fetchRelayed } from "@cafecode/relay/http";
import { RelayError } from "@cafecode/relay/errors";
import { Lifetime, epochNow } from "@cafecode/relay/lifetime";
import {
  ActiveRelay,
  installSavedRelay,
  readSavedRelay,
  savedRelayUrls,
  savedTransportTickets,
} from "./active";
import { encodeSavedRelaySecret, decodeSavedRelaySecret } from "./savedSecret";
import { writeSavedEnvironmentBearerToken, type SavedEnvironmentRecord } from "../runtime/catalog";

export async function pairSavedRelay(
  input: { label: string; relayInvitation: string; secondFactor?: string },
  primaryEnvironmentId?: string,
) {
  const url = new URL(input.relayInvitation);
  if (url.protocol !== "https:") throw new RelayError("PROTOCOL_ERROR");
  const invitation = parseInvitationUrl(input.relayInvitation, new Set([url.origin]), epochNow());
  if (invitation.environmentId === primaryEnvironmentId)
    throw new RelayError("ENVIRONMENT_MISMATCH");
  const lifetime = new Lifetime();
  let connection: Awaited<ReturnType<typeof connectViewer>> | undefined;
  try {
    const identity = await createIdentity(),
      admission = await createIdentity();
    const network = await discoverNetwork({
      bootstrapUrls: invitation.bootstrapUrls,
      rootPublicKey: invitation.networkRootPublicKey,
      minimumRevision: invitation.minimumRevision,
      lifetime,
    });
    connection = await connectViewer({
      target: {
        network,
        hostPublicKey: invitation.hostPublicKey,
        environmentId: invitation.environmentId,
        locator: invitation.locator,
        preferredNodeId: invitation.nodeId,
        deviceIdentity: identity,
        tickets: [
          {
            nodeId: invitation.nodeId,
            registrationId: invitation.registrationId,
            token: invitation.inviteTicket,
            expiresAt: invitation.expiresAt,
            admissionIdentity: admission,
          },
        ],
        paired: false,
      },
      dial: (node, resources) => connectBrowser(node.url, resources),
      lifetime,
    });
    // A one-use AUTH is sent only by this explicit submission, never by resume.
    const auth = await connection.session.authenticate({
      environmentId: invitation.environmentId,
      operation: "pair",
      credential: invitation.pairingSecret,
      ...(input.secondFactor ? { secondFactor: input.secondFactor } : {}),
    });
    const response = await fetchRelayed(connection.session, "/.well-known/cafe-code/environment");
    const descriptor = JSON.parse(
      new TextDecoder().decode(await readBoundedResponse(response, 16_384)),
    ) as ExecutionEnvironmentDescriptor;
    if (
      descriptor.environmentId !== invitation.environmentId ||
      auth.environmentId !== invitation.environmentId ||
      typeof descriptor.label !== "string"
    )
      throw new RelayError("ENVIRONMENT_MISMATCH");
    const id = opaque(
      sha256(
        concatenate(
          utf8.encode("CafeCode/relay/browser-target/v1\0"),
          unopaque(invitation.networkId, 32),
          unopaque(invitation.hostPublicKey, 32),
        ),
      ),
    );
    const target = {
      id,
      networkId: invitation.networkId,
      rootPublicKey: invitation.networkRootPublicKey,
      bootstrapUrls: invitation.bootstrapUrls,
      minimumRevision: network.revision,
      hostPublicKey: invitation.hostPublicKey,
      environmentId: invitation.environmentId,
      locator: invitation.locator,
      preferredNodeId: connection.nodeId,
      bearerToken: auth.bearerToken,
      tickets: savedTransportTickets(connection),
    };
    const record: SavedEnvironmentRecord = {
      transport: "relay",
      environmentId: EnvironmentId.make(invitation.environmentId),
      label: input.label.trim() || descriptor.label,
      ...savedRelayUrls(id),
      createdAt: new Date().toISOString(),
      lastConnectedAt: null,
    };
    return { record, secret: encodeSavedRelaySecret(target, identity), role: auth.role };
  } finally {
    lifetime.retire();
    try {
      await connection?.close();
    } finally {
      await lifetime.close();
    }
  }
}

export function activateSavedRelay(
  record: SavedEnvironmentRecord,
  secret: string,
): { relay: ActiveRelay; bearerToken: string } {
  const { target, identity } = decodeSavedRelaySecret(secret, record.environmentId);
  const urls = savedRelayUrls(target.id);
  if (urls.httpBaseUrl !== record.httpBaseUrl || urls.wsBaseUrl !== record.wsBaseUrl)
    throw new RelayError("ENVIRONMENT_MISMATCH");
  const existing = readSavedRelay(record.httpBaseUrl);
  if (existing) {
    if (!existing.matches(target, identity)) throw new RelayError("BUSY");
    return { relay: existing, bearerToken: target.bearerToken };
  }
  const relay = new ActiveRelay(
    target,
    identity,
    undefined,
    undefined,
    async (updated, key, signal) => {
      if (signal?.aborted) throw new RelayError("UNAVAILABLE");
      if (
        !(await writeSavedEnvironmentBearerToken(
          record.environmentId,
          encodeSavedRelaySecret(updated, key),
        ))
      )
        throw new RelayError("AUTH_REQUIRED");
      if (signal?.aborted) throw new RelayError("UNAVAILABLE");
    },
  );
  installSavedRelay(relay);
  return { relay, bearerToken: target.bearerToken };
}
