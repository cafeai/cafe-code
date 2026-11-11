import { canonicalBytes, readCanonical } from "@cafecode/relay/protocol";
import { opaque, unopaqueBounded, utf8, decodeUtf8 } from "@cafecode/relay/bytes";
import { privateIdentityBytes, restoreIdentity, type RelayIdentity } from "@cafecode/relay/crypto";
import { RelayError } from "@cafecode/relay/errors";
import { SavedRelayPayload } from "./storage";
import type { SavedRelayTarget } from "./active";

/** This payload uses the existing encrypted desktop secret slot. Browser
 * clients retain it only in their existing session-secret store, never metadata. */
export function encodeSavedRelaySecret(target: SavedRelayTarget, identity: RelayIdentity): string {
  return decodeUtf8(
    canonicalBytes({ target, devicePrivateKey: opaque(privateIdentityBytes(identity)) }, 16_384),
  );
}
export function decodeSavedRelaySecret(secret: string, environmentId: string) {
  if (secret.length > 16_384) throw new RelayError("AUTH_REQUIRED");
  const payload = readCanonical(SavedRelayPayload, utf8.encode(secret), 16_384);
  if (payload.target.environmentId !== environmentId) throw new RelayError("ENVIRONMENT_MISMATCH");
  return {
    target: payload.target,
    identity: restoreIdentity(unopaqueBounded(payload.devicePrivateKey, 128)),
  };
}
