import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpServerRequest } from "effect/unstable/http";
import { ServerConfig } from "../config.ts";
import { ScheduledFollowups } from "./service.ts";
import { handleSchedulingMcpRequest } from "./http.ts";

function request(peer: string | undefined, authorization?: string) {
  return HttpServerRequest.fromWeb(
    new Request("http://localhost/mcp/scheduling", {
      method: "POST",
      headers: { ...(authorization ? { authorization } : {}), "x-forwarded-for": "127.0.0.1" },
    }),
  ).modify({ remoteAddress: Option.fromUndefinedOr(peer) });
}
const handle = (value: ReturnType<typeof request>) =>
  Effect.runPromise(
    handleSchedulingMcpRequest.pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, value),
      Effect.provideService(ServerConfig, {} as never),
      Effect.provideService(ScheduledFollowups, {} as never),
    ),
  );
describe("session scheduling HTTP boundary", () => {
  it("rejects LAN HTTPS sibling requests even though their direct socket is loopback", async () => {
    const value = HttpServerRequest.fromWeb(
      new Request("http://localhost/mcp/scheduling", {
        method: "POST",
        headers: { authorization: `Bearer ${"a".repeat(64)}`, "x-cafe-code-https-proxy": "1" },
      }),
    ).modify({ remoteAddress: Option.some("127.0.0.1") });
    expect((await handle(value)).status).toBe(403);
  });
  it.each([undefined, "203.0.113.9", "192.168.1.4", "::ffff:192.168.1.4"])(
    "rejects nonlocal %s despite forwarded headers",
    async (peer) => {
      expect((await handle(request(peer, `Bearer ${"a".repeat(64)}`))).status).toBe(403);
    },
  );
  it.each([
    undefined,
    "Bearer owner-session",
    `Bearer ${"A".repeat(64)}`,
    `Basic ${"a".repeat(64)}`,
  ])("rejects absent or wrong-audience credentials %s", async (authorization) => {
    expect((await handle(request("127.0.0.1", authorization))).status).toBe(401);
  });
  it.each(["127.0.0.1", "::1", "::ffff:127.0.0.1"])(
    "never admits an unknown token from local peer %s",
    async (peer) => {
      expect((await handle(request(peer, `Bearer ${"a".repeat(64)}`))).status).toBe(403);
    },
  );
});
