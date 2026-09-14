import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpServerRequest } from "effect/unstable/http";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { handleDesktopMcpRequest } from "./http.ts";

describe("Desktop Control direct peer boundary", () => {
  it.each([undefined, "203.0.113.9", "192.168.1.4", "::ffff:192.168.1.4"])(
    "rejects peer %s before credentials or forwarded locality can grant access",
    async (peer) => {
      const request = HttpServerRequest.fromWeb(
        new Request("http://localhost/mcp/desktop", {
          method: "POST",
          headers: {
            authorization: `Bearer ${"a".repeat(64)}`,
            forwarded: "for=127.0.0.1;host=localhost",
            "x-forwarded-for": "127.0.0.1",
          },
        }),
      ).modify({ remoteAddress: Option.fromUndefinedOr(peer) });
      const response = await Effect.runPromise(
        handleDesktopMcpRequest.pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, request),
          // Neither service is read before rejecting a non-local transport.
          Effect.provideService(ServerConfig, {} as never),
          Effect.provideService(ServerSettingsService, {
            getSettings: Effect.die("Non-local request reached credential admission"),
          } as never),
        ),
      );
      expect(response.status).toBe(403);
    },
  );
});
