// @effect-diagnostics nodeBuiltinImport:off
// Native address parsing and constant-time verification of the private
// gateway credential. Forwarding affects admission buckets only, never auth.
import { isIP, SocketAddress } from "node:net";
import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { unopaque } from "@cafecode/relay/bytes";
import { requireRelay } from "@cafecode/relay/errors";

export const FORWARD_KEY_HEADER = "x-cafe-relay-forward-key";

export function peerPrefix(address: string | undefined): string {
  requireRelay(address && address.length <= 64 && !address.includes("%"));
  const family = isIP(address);
  requireRelay(family === 4 || family === 6);
  const canonical = new SocketAddress({ address, port: 0, family: family === 6 ? "ipv6" : "ipv4" })
    .address;
  const value = canonical.startsWith("::ffff:") ? canonical.slice(7) : canonical;
  if (isIP(value) === 4) return "v4:" + value;
  const halves = value.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const words =
    halves.length === 2
      ? [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right]
      : left;
  requireRelay(words.length === 8);
  return (
    "v6:" +
    words
      .slice(0, 4)
      .map((word) => Number.parseInt(word, 16).toString(16))
      .join(":")
  );
}

export class PeerAttribution {
  private readonly keys: readonly Uint8Array[];

  constructor(keys: readonly string[] = []) {
    requireRelay(keys.length <= 2);
    this.keys = keys.map((key) => unopaque(key, 32));
  }

  prefix(headers: IncomingHttpHeaders, address: string | undefined): string {
    const credential = headers[FORWARD_KEY_HEADER];
    // Public origin connections remain supported. Arbitrary forwarding headers
    // on them cannot select an attacker-chosen limiter bucket.
    if (credential === undefined) return peerPrefix(address);
    requireRelay(typeof credential === "string" && this.keys.length > 0, "AUTH_DENIED");
    const bytes = unopaque(credential, 32);
    let matched = 0;
    for (const key of this.keys) matched |= Number(timingSafeEqual(bytes, key));
    requireRelay(matched !== 0, "AUTH_DENIED");
    const client = headers["cf-connecting-ip"];
    requireRelay(typeof client === "string", "AUTH_DENIED");
    return peerPrefix(client);
  }
}
