import { describe, expect, it } from "vitest";
import * as Option from "effect/Option";
import { HttpServerRequest } from "effect/unstable/http";
import { makeHttpsProxyAuthority, isLocalPeer } from "./httpTransport.ts";

describe("private HTTPS sibling provenance", () => {
  it("requires the exact process capability and native peer, stripping supplied provenance", () => {
    const authority = makeHttpsProxyAuthority();
    const headers = authority.headers(
      {
        "x-forwarded-for": "forged",
        forwarded: "forged",
        "x-cafe-code-proxy-client": "forged",
        "x-cafe-code-https-proxy": "1",
        authorization: "Bearer preserved",
      },
      "203.0.113.4",
    );
    expect(headers).not.toHaveProperty("x-forwarded-for");
    expect(headers).not.toHaveProperty("forwarded");
    expect(headers.authorization).toBe("Bearer preserved");
    expect(headers["x-cafe-code-proxy-client"]).toBe("203.0.113.4");
    const request = (peer: string, input = headers) =>
      HttpServerRequest.fromWeb(
        new Request("http://localhost/", { headers: input as Record<string, string> }),
      ).modify({ remoteAddress: Option.some(peer) });
    for (const peer of ["127.0.0.1", "::1", "::ffff:127.0.0.1"])
      expect(authority.isAuthenticated(request(peer))).toBe(true);
    expect(authority.isAuthenticated(request("203.0.113.4"))).toBe(false);
    expect(
      authority.isAuthenticated(
        request("127.0.0.1", {
          "x-cafe-code-https-proxy": "1",
          "x-forwarded-proto": "https",
        } as typeof headers),
      ),
    ).toBe(false);
    expect(makeHttpsProxyAuthority().isAuthenticated(request("127.0.0.1"))).toBe(false);
    expect(isLocalPeer("127.bad.host")).toBe(false);
  });
});
