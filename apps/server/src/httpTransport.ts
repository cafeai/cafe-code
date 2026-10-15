// @effect-diagnostics nodeBuiltinImport:off
import { randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import * as Option from "effect/Option";
import type { HttpServerRequest } from "effect/unstable/http";

const authorizationHeader = "x-cafe-code-proxy-authorization";
const clientHeader = "x-cafe-code-proxy-client";
const normalize = (address: string) => address.replace(/^::ffff:/u, "").replace(/^\[|\]$/gu, "");
export const isLocalPeer = (address: string) => {
  const value = normalize(address);
  return value === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(value);
};

/** Private, process-local capability. Never serialize it to settings, URLs or logs. */
export function makeHttpsProxyAuthority() {
  const capability = randomBytes(32).toString("hex");
  const peers = new Set<string>();
  return {
    admitPeer(address: string) {
      const value = normalize(address);
      if (isIP(value)) peers.add(value);
    },
    headers(
      headers: Readonly<Record<string, string | string[] | undefined>>,
      client: string,
    ): Record<string, string | string[] | undefined> {
      const clean = Object.fromEntries(
        Object.entries(headers).filter(
          ([name]) =>
            !name.toLowerCase().startsWith("x-forwarded-") &&
            !name.toLowerCase().startsWith("x-cafe-code-proxy-") &&
            name.toLowerCase() !== "forwarded" &&
            name.toLowerCase() !== "x-cafe-code-https-proxy",
        ),
      );
      return {
        ...clean,
        "x-forwarded-proto": "https",
        "x-cafe-code-https-proxy": "1",
        [authorizationHeader]: capability,
        [clientHeader]: client,
      };
    },
    isAuthenticated(request: {
      readonly headers: Readonly<Record<string, string | undefined>>;
      readonly remoteAddress: Option.Option<string>;
    }) {
      const supplied = request.headers[authorizationHeader];
      if (!supplied || !/^[a-f0-9]{64}$/u.test(supplied)) return false;
      const peer = Option.getOrElse(request.remoteAddress, () => "");
      return (
        (isLocalPeer(peer) || peers.has(normalize(peer))) &&
        timingSafeEqual(Buffer.from(supplied), Buffer.from(capability))
      );
    },
  };
}

export const httpsProxyAuthority = makeHttpsProxyAuthority();
export const isHttpsProxyRequest = httpsProxyAuthority.isAuthenticated;
export function trustedClientAddress(
  request: HttpServerRequest.HttpServerRequest,
): string | undefined {
  const forwarded = request.headers[clientHeader];
  return isHttpsProxyRequest(request) && forwarded && isIP(normalize(forwarded))
    ? normalize(forwarded)
    : Option.getOrUndefined(request.remoteAddress);
}
