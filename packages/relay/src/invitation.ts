import * as Schema from "effect/Schema";
import { deriveIdentityId } from "./crypto.ts";
import { opaque, unopaque, unopaqueBounded, utf8 } from "./bytes.ts";
import { isLoopbackHost } from "./descriptor.ts";
import { parseRelayUrl, requireRelay } from "./errors.ts";
import { RELAY_LIMITS } from "./limits.ts";
import { Id16, Id32, SafeCounter, canonicalBytes, readCanonical } from "./protocol.ts";

const ShortString = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
export const RelayInvitation = Schema.Struct({
  version: Schema.Literal(1),
  networkId: Id32,
  networkRootPublicKey: Id32,
  minimumRevision: SafeCounter,
  bootstrapUrls: Schema.Array(Schema.String.check(Schema.isMaxLength(256))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(3),
  ),
  hostPublicKey: Id32,
  environmentId: ShortString,
  locator: Id32,
  nodeId: Id32,
  registrationId: Id16,
  inviteTicket: Id32,
  pairingSecret: Id32,
  expiresAt: SafeCounter,
});
export type RelayInvitation = typeof RelayInvitation.Type;
const fragmentPrefix = "#cafe-relay=";

function validate(invite: RelayInvitation, now: number, allowLoopbackTest: boolean): void {
  requireRelay(
    invite.expiresAt > now &&
      invite.expiresAt <= now + RELAY_LIMITS.invitationMs + RELAY_LIMITS.clockSkewMs,
    "EXPIRED",
  );
  requireRelay(
    invite.networkId === deriveIdentityId("network", invite.networkRootPublicKey),
    "NETWORK_MISMATCH",
  );
  for (const key of [
    invite.hostPublicKey,
    invite.locator,
    invite.nodeId,
    invite.inviteTicket,
    invite.pairingSecret,
  ])
    unopaque(key, 32);
  for (const endpoint of invite.bootstrapUrls) {
    const url = parseRelayUrl(endpoint);
    requireRelay(
      url.protocol === "https:" ||
        (allowLoopbackTest && url.protocol === "http:" && isLoopbackHost(url.hostname)),
    );
    requireRelay(
      !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === "/v1/network" &&
        endpoint === url.href,
    );
  }
}

export function createInvitationUrl(
  origin: string,
  invitation: RelayInvitation,
  now: number,
  allowLoopbackTest = false,
): string {
  const url = parseRelayUrl(origin);
  requireRelay(url.origin === origin);
  requireRelay(
    url.protocol === "https:" ||
      (allowLoopbackTest && url.protocol === "http:" && isLoopbackHost(url.hostname)),
  );
  validate(invitation, now, allowLoopbackTest);
  url.pathname = "/relay/pair";
  url.hash =
    fragmentPrefix.slice(1) + opaque(canonicalBytes(invitation, RELAY_LIMITS.invitationBytes));
  requireRelay(utf8.encode(url.href).byteLength <= RELAY_LIMITS.invitationUrlBytes);
  return url.href;
}

/**
 * The caller provides trusted frontend origins independently of the invitation.
 * Clear the browser fragment before starting any async discovery or auth work.
 */
export function parseInvitationUrl(
  value: string,
  trustedOrigins: ReadonlySet<string>,
  now: number,
  allowLoopbackTest = false,
): RelayInvitation {
  requireRelay(utf8.encode(value).byteLength <= RELAY_LIMITS.invitationUrlBytes);
  const url = parseRelayUrl(value);
  requireRelay(trustedOrigins.has(url.origin) && url.pathname === "/relay/pair" && !url.search);
  requireRelay(
    url.protocol === "https:" ||
      (allowLoopbackTest && url.protocol === "http:" && isLoopbackHost(url.hostname)),
  );
  requireRelay(url.hash.startsWith(fragmentPrefix));
  const invite = readCanonical(
    RelayInvitation,
    unopaqueBounded(url.hash.slice(fragmentPrefix.length), RELAY_LIMITS.invitationBytes),
    RELAY_LIMITS.invitationBytes,
  );
  validate(invite, now, allowLoopbackTest);
  return invite;
}
