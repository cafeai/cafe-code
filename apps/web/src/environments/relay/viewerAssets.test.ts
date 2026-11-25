import { describe, expect, it, vi } from "vitest";
import { Lifetime } from "@cafecode/relay/lifetime";
import { fetchRelayed } from "@cafecode/relay/http";
import type { RelaySession } from "@cafecode/relay/session";
import {
  RELAY_VIEWER_PATH,
  RELAY_VIEWER_PROBE_ACCEPT,
  RELAY_VIEWER_PROBE_PATH,
} from "@cafecode/relay/viewerBundle";
import { pinViewerTransport } from "./viewerAssets";

vi.mock("@cafecode/relay/http", () => ({ fetchRelayed: vi.fn() }));

describe("hosted viewer session identity", () => {
  function fixture() {
    const lifetime = new Lifetime();
    const changed = vi.fn();
    const first = { active: true } as RelaySession;
    const relay = {
      environmentId: "fixture",
      httpBaseUrl: "https://fixture.cafecode-relay.invalid/",
      wsBaseUrl: "wss://fixture.cafecode-relay.invalid/",
      session: vi.fn().mockResolvedValue(first),
      close: vi.fn(),
    };
    const request = vi.mocked(fetchRelayed);
    request.mockReset();
    return { lifetime, changed, first, relay, request };
  }

  it("detects a legacy server through its existing environment route without opening a code stream", async () => {
    const { lifetime, changed, relay, request, first } = fixture();
    request.mockResolvedValueOnce(Response.json({ environmentId: "legacy-host" }));
    try {
      await expect(
        pinViewerTransport(relay, lifetime, lifetime.signal, changed),
      ).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      expect(request).toHaveBeenCalledExactlyOnceWith(first, RELAY_VIEWER_PROBE_PATH, {
        headers: { accept: RELAY_VIEWER_PROBE_ACCEPT },
        signal: lifetime.signal,
      });
      expect(changed).not.toHaveBeenCalled();
    } finally {
      await lifetime.close();
    }
  });

  it("blocks application requests on a replacement session advertising different build bytes", async () => {
    const { lifetime, changed, relay, request, first } = fixture();
    const bytes = new TextEncoder().encode("fixture manifest");
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const second = { active: true } as RelaySession;
    const upgraded = { active: true } as RelaySession;
    request.mockImplementation(async (session, path) => {
      if (path === RELAY_VIEWER_PROBE_PATH) {
        return Response.json({
          relayViewerBuildDigest: session === upgraded ? "f".repeat(64) : digest,
        });
      }
      if (path === RELAY_VIEWER_PATH + "/manifest") return new Response(bytes);
      return new Response("fixture reply");
    });
    try {
      const { transport } = await pinViewerTransport(relay, lifetime, lifetime.signal, changed);
      expect(request.mock.calls.map(([session, path]) => [session, path])).toEqual([
        [first, RELAY_VIEWER_PROBE_PATH],
        [first, RELAY_VIEWER_PATH + "/manifest"],
      ]);
      request.mockClear();
      relay.session.mockResolvedValue(second);
      await Promise.all([transport.request("/api/one"), transport.request("/api/two")]);
      expect(
        request.mock.calls.filter(([, path]) => path === RELAY_VIEWER_PROBE_PATH),
      ).toHaveLength(1);
      expect(request.mock.calls.every(([session]) => session === second)).toBe(true);
      request.mockClear();
      relay.session.mockResolvedValue(upgraded);
      await expect(transport.request("/api/three")).rejects.toMatchObject({ code: "UNAVAILABLE" });
      expect(changed).toHaveBeenCalledTimes(1);
      expect(request.mock.calls.map(([session, path]) => [session, path])).toEqual([
        [upgraded, RELAY_VIEWER_PROBE_PATH],
      ]);
    } finally {
      await lifetime.close();
    }
  });
});
