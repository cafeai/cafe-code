import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { describe, expect, it } from "vitest";
import { httpSecurityLayer } from "./httpSecurity.ts";
import { ServerConfig } from "./config.ts";

describe("external HTTPS policy before route execution", () => {
  it("rejects spoofed provenance and every sensitive route before its handler can read credentials", async () => {
    let calls = 0;
    const routes = Layer.mergeAll(
      HttpRouter.add(
        "*",
        "/*",
        Effect.sync(() => {
          calls++;
          return HttpServerResponse.empty({ status: 204 });
        }),
      ),
      httpSecurityLayer,
    );
    const app = HttpRouter.toWebHandler(routes, { disableLogger: true });
    const context = Context.make(ServerConfig, { httpsEnabled: true, httpsPort: 9443 } as never);
    try {
      for (const path of [
        "/api/auth/bootstrap",
        "/api/client-debug-log",
        "/attachments/private.png",
        "/api/chat-images",
        "/ws",
        "/mcp",
        "/mcp/scheduling",
        "/api/../api/auth/bootstrap",
      ]) {
        const response = await app.handler(
          new Request(`http://cafe.example${path}`, {
            method: path === "/ws" ? "GET" : "POST",
            headers: {
              "x-cafe-code-https-proxy": "1",
              "x-forwarded-proto": "https",
              "x-cafe-code-proxy-authorization": "a".repeat(64),
            },
          }),
          context,
        );
        expect(response.status).toBe(403);
      }
      expect(calls).toBe(0);
      expect((await app.handler(new Request("http://cafe.example/"), context)).status).toBe(204);
      const httpOnly = Context.make(ServerConfig, { httpsEnabled: false } as never);
      expect(
        (
          await app.handler(
            new Request("http://cafe.example/api/auth/bootstrap", { method: "POST" }),
            httpOnly,
          )
        ).status,
      ).toBe(204);
      expect(calls).toBe(2);
    } finally {
      await app.dispose();
    }
  });
});
