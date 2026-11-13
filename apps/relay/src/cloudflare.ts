// @effect-diagnostics globalTimers:off
// Native edge boundary: each timer belongs to one bounded origin handshake or
// metadata exchange, and is cleared before returning the upgraded connection.

const VIEWER = "relay.cafecode.sh";
const SUBPROTOCOL = "cafe-relay.v1";
const ORIGINS: Readonly<Record<string, string>> = {
  "relay-uk.cafecode.sh": "https://vps-692e150f.vps.ovh.net:8443",
  "relay-ca.cafecode.sh": "https://vps-697b49f9.vps.ovh.ca:8443",
  "relay-us-west.cafecode.sh": "https://vps-7bd57ed1.vps.ovh.us:8443",
};

export interface RelayEdgeEnvironment {
  ASSETS: { fetch(request: Request): Promise<Response> };
  RELAY_FORWARD_UK_KEY?: string;
  RELAY_FORWARD_CA_KEY?: string;
  RELAY_FORWARD_US_WEST_KEY?: string;
}

const security = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};
function refusal(status = 404) {
  return new Response(null, { status, headers: { ...security, ...cors } });
}

async function bounded(
  body: ReadableStream<Uint8Array> | null,
  maximum: number,
  signal: AbortSignal,
) {
  const reader = body?.getReader();
  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let length = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (signal.aborted) throw new Error("relay-edge-retired");
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximum) throw new Error("relay-edge-body-limit");
      parts.push(chunk.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    return bytes;
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function viewer(request: Request, env: RelayEdgeEnvironment, url: URL) {
  if (request.method !== "GET" && request.method !== "HEAD") return refusal(405);
  if (url.pathname === "/") {
    return new Response(null, {
      status: 302,
      headers: { ...security, location: "/relay/connect" },
    });
  }
  if (/(?:^|\/)\./.test(url.pathname) || /^\/(?:api|attachments|ws)(?:\/|$)/.test(url.pathname))
    return refusal();
  const asset = new URL(url.origin);
  asset.pathname = ["/relay/connect", "/relay/pair"].includes(url.pathname)
    ? "/index.html"
    : url.pathname;
  // Never send domain-wide cookies, bearer credentials, invitation fragments,
  // arbitrary proxy headers or query strings to the asset service.
  const headers = new Headers();
  for (const name of ["accept", "accept-encoding", "if-none-match"]) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const response = await env.ASSETS.fetch(new Request(asset, { method: request.method, headers }));
  if (
    response.status === 404 &&
    asset.pathname !== "/index.html" &&
    request.headers.get("accept")?.includes("text/html") &&
    !url.pathname.startsWith("/assets/") &&
    !url.pathname.split("/").at(-1)?.includes(".")
  ) {
    await response.body?.cancel();
    return new Response(null, {
      status: 302,
      headers: { ...security, location: "/relay/connect" },
    });
  }
  const result = new Headers(response.headers);
  result.delete("set-cookie");
  for (const [name, value] of Object.entries(security)) result.set(name, value);
  if (response.status === 200 && asset.pathname.startsWith("/assets/")) {
    result.set("cache-control", "public, max-age=31536000, immutable");
  }
  return new Response(response.body, { status: response.status, headers: result });
}

export async function relayEdgeFetch(
  request: Request,
  env: RelayEdgeEnvironment,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.protocol !== "https:") return refusal(400);
  if (url.hostname === VIEWER) return viewer(request, env, url);
  const origin = ORIGINS[url.hostname];
  if (!origin || url.search || url.hash) return refusal();
  if (url.pathname === "/v1/lookup" && request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...security, ...cors } });
  }
  const websocket =
    url.pathname === "/v1/relay" &&
    request.method === "GET" &&
    request.headers.get("upgrade")?.toLowerCase() === "websocket" &&
    request.headers.get("sec-websocket-protocol") === SUBPROTOCOL;
  const lookup = url.pathname === "/v1/lookup" && request.method === "POST";
  const hostWork =
    request.method === "POST" &&
    ["/v1/host/challenge", "/v1/host/claim", "/v1/host/release"].includes(url.pathname);
  const metadata =
    request.method === "GET" && ["/v1/network", "/v1/latency", "/healthz"].includes(url.pathname);
  if (!websocket && !lookup && !hostWork && !metadata) return refusal();
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) abort();
  const deadline = setTimeout(abort, 10_000);
  try {
    const headers = new Headers();
    if (websocket) {
      for (const name of [
        "upgrade",
        "sec-websocket-key",
        "sec-websocket-version",
        "sec-websocket-protocol",
        "origin",
      ]) {
        const value = request.headers.get(name);
        if (value !== null) headers.set(name, value);
      }
    } else if (lookup || hostWork) headers.set("content-type", "application/json");
    const forwardingKey = (
      {
        "relay-uk.cafecode.sh": env.RELAY_FORWARD_UK_KEY,
        "relay-ca.cafecode.sh": env.RELAY_FORWARD_CA_KEY,
        "relay-us-west.cafecode.sh": env.RELAY_FORWARD_US_WEST_KEY,
      } as Readonly<Record<string, string | undefined>>
    )[url.hostname];
    if (forwardingKey !== undefined) {
      const client = request.headers.get("cf-connecting-ip");
      // CF supplies this header on the incoming request. Do not copy a caller's
      // X-Forwarded-For, X-Real-IP or private gateway-credential header.
      if (
        !/^[A-Za-z0-9_-]{43}$/.test(forwardingKey) ||
        !client ||
        client.length > 64 ||
        !/^[0-9A-Fa-f:.]+$/.test(client)
      )
        return refusal(400);
      headers.set("cf-connecting-ip", client);
      headers.set("x-cafe-relay-forward-key", forwardingKey);
    }
    const body =
      lookup || hostWork
        ? await bounded(request.body, hostWork ? 4096 : 8_192, controller.signal)
        : undefined;
    if (hostWork && request.headers.get("x-cafe-host-work-zero") === "1")
      headers.set("x-cafe-host-work-zero", "1");
    const upstream = await fetcher(new URL(url.pathname, origin), {
      method: request.method,
      headers,
      ...(body ? { body: body.slice() } : {}),
      signal: controller.signal,
      redirect: "manual",
    });
    if (websocket && upstream.status === 101) {
      // Cloudflare's native Response extension retains the unaccepted WebSocket
      // for pass-through. Never terminate Noise here or forward origin cookies.
      const socket = (upstream as Response & { webSocket?: WebSocket }).webSocket;
      if (!socket) return refusal(502);
      const init: ResponseInit & { webSocket: WebSocket } = {
        status: 101,
        webSocket: socket,
        headers: { ...security, "sec-websocket-protocol": SUBPROTOCOL },
      };
      return new Response(null, init);
    }
    if (websocket) {
      await upstream.body?.cancel();
      return refusal(upstream.status === 429 ? 429 : 502);
    }
    const bytes = await bounded(upstream.body, 65_536, controller.signal);
    if (upstream.status !== 200) return refusal(upstream.status === 429 ? 429 : 502);
    return new Response(bytes, {
      status: 200,
      headers: { ...security, ...cors, "content-type": "application/json" },
    });
  } catch {
    return refusal(502);
  } finally {
    clearTimeout(deadline);
    request.signal.removeEventListener("abort", abort);
  }
}

export default {
  fetch(request: Request, env: RelayEdgeEnvironment) {
    return relayEdgeFetch(request, env);
  },
};
