import { isLoopbackRemoteAddress } from "../http.ts";
import { isIP } from "node:net";

/**
 * Authentication admits ordinary collaboration views, not private error JSON.
 * The transport boolean is supplied only by the route's observed-peer policy:
 * HTTPS terminates at Cafe's loopback sibling; forwarded headers are ignored.
 */
export function canReadProviderActivityDiagnostic(
  role: unknown,
  secureSecretTransport: boolean,
): boolean {
  return role === "owner" && secureSecretTransport === true;
}

/** Absent/empty observed peer is uncertainty, not same-machine evidence. */
export function hasObservedPrivateRpcTransport(address: string | undefined): boolean {
  if (typeof address !== "string") return false;
  // The legacy bootstrap helper also accepts missing addresses and lexical
  // loopback prefixes. Private RPC authority needs an actual observed IP:
  // bracket normalization must not turn "[]" into that legacy empty sentinel.
  const normalized = address
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return isIP(normalized) !== 0 && isLoopbackRemoteAddress(normalized);
}
