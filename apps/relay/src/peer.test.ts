import { describe, expect, it } from "vitest";
import { AdmissionLimiter } from "@cafecode/relay/budget";
import { opaque } from "@cafecode/relay/bytes";
import { FORWARD_KEY_HEADER, PeerAttribution, peerPrefix } from "./peer.ts";

const current = opaque(new Uint8Array(32).fill(1));
const previous = opaque(new Uint8Array(32).fill(2));
const foreign = opaque(new Uint8Array(32).fill(3));

describe("authenticated gateway client attribution", () => {
  it("keeps direct header claims in their actual socket bucket", () => {
    const peers = new PeerAttribution([current]);
    const limiter = new AdmissionLimiter(0);
    for (let index = 0; index < 5; index++) {
      const prefix = peers.prefix(
        { "cf-connecting-ip": `203.0.113.${index}`, "x-forwarded-for": `192.0.2.${index}` },
        "198.51.100.1",
      );
      expect(prefix).toBe("v4:198.51.100.1");
      expect(limiter.admit(prefix, 0)).toBe(index < 4);
    }
  });

  it("uses independent client buckets only with this relay's gateway credential", () => {
    const peers = new PeerAttribution([current, previous]),
      limiter = new AdmissionLimiter(0);
    const first = peers.prefix(
      { [FORWARD_KEY_HEADER]: current, "cf-connecting-ip": "203.0.113.1" },
      "198.51.100.1",
    );
    for (let index = 0; index < 4; index++) expect(limiter.admit(first, 0)).toBe(true);
    expect(limiter.admit(first, 0)).toBe(false);
    const second = peers.prefix(
      { [FORWARD_KEY_HEADER]: previous, "cf-connecting-ip": "203.0.113.2" },
      "198.51.100.1",
    );
    expect(limiter.admit(second, 0)).toBe(true);
    expect(() =>
      peers.prefix(
        { [FORWARD_KEY_HEADER]: foreign, "cf-connecting-ip": "203.0.113.3" },
        "198.51.100.1",
      ),
    ).toThrow();
    expect(() =>
      new PeerAttribution().prefix(
        { [FORWARD_KEY_HEADER]: current, "cf-connecting-ip": "203.0.113.3" },
        "198.51.100.1",
      ),
    ).toThrow();
  });

  it("rejects malformed, duplicate, list, port and scoped address claims", () => {
    const peers = new PeerAttribution([current]);
    for (const client of [
      undefined,
      "",
      "999.1.2.3",
      "203.0.113.1, 192.0.2.1",
      "203.0.113.1:443",
      " 203.0.113.1",
      "[2001:db8::1]",
      "fe80::1%lo0",
    ]) {
      expect(() =>
        peers.prefix({ [FORWARD_KEY_HEADER]: current, "cf-connecting-ip": client }, "198.51.100.1"),
      ).toThrow();
    }
    for (const credential of ["invalid", `${current}, ${current}`, [current, current]]) {
      expect(() =>
        peers.prefix(
          { [FORWARD_KEY_HEADER]: credential, "cf-connecting-ip": "203.0.113.1" },
          "198.51.100.1",
        ),
      ).toThrow();
    }
  });

  it("normalizes equivalent IPv6 and mapped IPv4 addresses before quota admission", () => {
    expect(peerPrefix("2001:0DB8:0:0:1:2:3:4")).toBe(peerPrefix("2001:db8::abcd"));
    expect(peerPrefix("::ffff:c000:202")).toBe(peerPrefix("192.0.2.2"));
    expect(peerPrefix("::ffff:192.0.2.2")).toBe(peerPrefix("192.0.2.2"));
    expect(peerPrefix("2001:db8:0:1::1")).not.toBe(peerPrefix("2001:db8::1"));
  });
});
