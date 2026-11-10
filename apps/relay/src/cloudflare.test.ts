import { describe, expect, it, vi } from "vitest";
import { relayEdgeFetch, type RelayEdgeEnvironment } from "./cloudflare.ts";

function fixture() {
  const assets = vi.fn<(request: Request) => Promise<Response>>(
    async () => new Response("viewer", { headers: { "set-cookie": "bad=1" } }),
  );
  const origin = vi.fn<typeof fetch>(
    async () =>
      new Response('{"signed":"unchanged"}', {
        headers: { "set-cookie": "bad=1", location: "https://evil.example" },
      }),
  );
  const env: RelayEdgeEnvironment = { ASSETS: { fetch: assets } };
  return { assets, origin, env };
}

describe("Cloudflare relay gateway policy", () => {
  it("preserves the exact relay WebSocket subprotocol and excludes credentials", async () => {
    const f = fixture();
    f.origin.mockImplementation(async () => new Response(null, { status: 503 }));
    const upgrade = (protocol?: string) =>
      new Request("https://relay-uk.cafecode.sh/v1/relay", {
        headers: {
          upgrade: "websocket",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          "sec-websocket-version": "13",
          ...(protocol ? { "sec-websocket-protocol": protocol } : {}),
          cookie: "parent=private",
          authorization: "Bearer private",
        },
      });
    for (const protocol of [undefined, "foreign", "cafe-relay.v1, foreign"]) {
      expect((await relayEdgeFetch(upgrade(protocol), f.env, f.origin)).status).toBe(404);
    }
    expect(f.origin).not.toHaveBeenCalled();
    expect((await relayEdgeFetch(upgrade("cafe-relay.v1"), f.env, f.origin)).status).toBe(502);
    const [, init] = f.origin.mock.calls[0]!;
    const headers = new Headers(init!.headers);
    expect(headers.get("sec-websocket-protocol")).toBe("cafe-relay.v1");
    expect(headers.get("upgrade")).toBe("websocket");
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("cookie")).toBeNull();
    expect(f.assets).not.toHaveBeenCalled();
  });
  it("recovers document navigation without converting missing scripts or APIs into HTML", async () => {
    const f = fixture();
    f.assets.mockImplementation(async () => new Response(null, { status: 404 }));
    const navigation = (path: string) =>
      new Request("https://relay.cafecode.sh" + path, { headers: { accept: "text/html" } });
    const response = await relayEdgeFetch(navigation("/thread/example"), f.env, f.origin);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/relay/connect");
    for (const path of ["/assets/missing.js", "/missing.js", "/api/private"]) {
      const response = await relayEdgeFetch(navigation(path), f.env, f.origin);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(f.origin).not.toHaveBeenCalled();
  });
  it("isolates trusted viewer assets and removes ambient credentials", async () => {
    const f = fixture();
    let assetRequest: Request | undefined;
    f.assets.mockImplementation(async (request: Request) => {
      assetRequest = request;
      return new Response("viewer", { headers: { "set-cookie": "bad=1" } });
    });
    const response = await relayEdgeFetch(
      new Request("https://relay.cafecode.sh/relay/pair?secret=discard", {
        headers: { cookie: "parent=private", authorization: "Bearer private" },
      }),
      f.env,
      f.origin,
    );
    expect(await response.text()).toBe("viewer");
    expect(assetRequest?.url).toBe("https://relay.cafecode.sh/index.html");
    expect([...assetRequest!.headers]).toEqual([]);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(f.origin).not.toHaveBeenCalled();
    for (const path of ["/api/private", "/.env", "/attachments/a"]) {
      expect(
        (await relayEdgeFetch(new Request("https://relay.cafecode.sh" + path), f.env, f.origin))
          .status,
      ).toBe(404);
    }
    expect(f.assets).toHaveBeenCalledTimes(1);
  });

  it("forwards only fixed public relay routes and preserves signed bytes", async () => {
    const f = fixture();
    const request = new Request("https://relay-ca.cafecode.sh/v1/lookup", {
      method: "POST",
      body: '{"locator":"test"}',
      headers: {
        cookie: "parent=private",
        authorization: "Bearer private",
        "x-forwarded-for": "1.2.3.4",
      },
    });
    const response = await relayEdgeFetch(request, f.env, f.origin);
    expect(await response.text()).toBe('{"signed":"unchanged"}');
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(f.origin).toHaveBeenCalledTimes(1);
    const [url, init] = f.origin.mock.calls[0]!;
    expect(String(url)).toBe("https://vps-697b49f9.vps.ovh.ca:8443/v1/lookup");
    expect([...new Headers(init!.headers)]).toEqual([["content-type", "application/json"]]);
    expect(new TextDecoder().decode(init!.body as Uint8Array)).toBe('{"locator":"test"}');
    expect(f.assets).not.toHaveBeenCalled();
    for (const path of [
      "/",
      "/index.html",
      "/v1/network?redirect=https://evil.example",
      "/v1/relay",
    ]) {
      expect(
        (await relayEdgeFetch(new Request("https://relay-ca.cafecode.sh" + path), f.env, f.origin))
          .status,
      ).toBe(404);
    }
    expect(
      (await relayEdgeFetch(new Request("https://unknown.cafecode.sh/v1/network"), f.env, f.origin))
        .status,
    ).toBe(404);
    expect(f.origin).toHaveBeenCalledTimes(1);
  });

  it("bounds request and origin response bodies and refuses redirects", async () => {
    const f = fixture();
    expect(
      (
        await relayEdgeFetch(
          new Request("https://relay-uk.cafecode.sh/v1/lookup", {
            method: "POST",
            body: new Uint8Array(8_193),
          }),
          f.env,
          f.origin,
        )
      ).status,
    ).toBe(502);
    expect(f.origin).not.toHaveBeenCalled();
    f.origin.mockResolvedValueOnce(new Response(new Uint8Array(65_537)));
    const request = () => new Request("https://relay-uk.cafecode.sh/v1/network");
    expect((await relayEdgeFetch(request(), f.env, f.origin)).status).toBe(502);
    f.origin.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "https://evil.example" } }),
    );
    expect((await relayEdgeFetch(request(), f.env, f.origin)).status).toBe(502);
    expect(f.origin.mock.calls.every(([, init]) => init?.redirect === "manual")).toBe(true);
  });

  it("cancels an exact stalled request body when its client retires", async () => {
    const f = fixture(),
      controller = new AbortController(),
      reading = Promise.withResolvers<void>();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        reading.resolve();
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("https://relay-us-west.cafecode.sh/v1/lookup", {
      method: "POST",
      body,
      signal: controller.signal,
      duplex: "half",
    } as RequestInit);
    const response = relayEdgeFetch(request, f.env, f.origin);
    await reading.promise;
    controller.abort();
    expect((await response).status).toBe(502);
    expect(cancelled).toBe(true);
    expect(f.origin).not.toHaveBeenCalled();
  });
});
