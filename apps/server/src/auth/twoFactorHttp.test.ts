import { AuthSessionId } from "@cafecode/contracts/auth";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { HttpRouter } from "effect/unstable/http";
import { describe, expect, it, vi } from "vitest";
import { AuthError, ServerAuth, type ServerAuthShape } from "./Services/ServerAuth.ts";
import { TwoFactorService } from "./Services/TwoFactorService.ts";
import { authTwoFactorRouteLayer } from "./twoFactorHttp.ts";

const request = (path: string, token: string) =>
  new Request(`http://localhost/api/auth/two-factor${path}`, {
    method: path ? "POST" : "GET",
    headers: { authorization: token, "content-type": "application/json" },
    ...(path ? { body: JSON.stringify({ code: "123456" }) } : {}),
  });

describe("two-factor HTTP ownership and refusal", () => {
  it("requires an owner before any read, setup, enable or disable effect and emits bounded cooldown receipts", async () => {
    const begin = vi.fn(() => Effect.succeed({ secret: "TEST", uri: "otpauth://test" }));
    const enable = vi.fn(() => Effect.succeed({ recoveryCodes: ["test-recovery"] }));
    const disable = vi.fn(() => Effect.void);
    const auth = {
      authenticateHttpRequest: (request) => {
        const token = request.headers.authorization;
        return token === "Bearer owner" || token === "Bearer client"
          ? Effect.succeed({
              sessionId: AuthSessionId.make(token),
              subject: "fixture",
              method: "bearer-session-token" as const,
              role: token === "Bearer owner" ? ("owner" as const) : ("client" as const),
            })
          : Effect.fail(new AuthError({ message: "Unauthorized", status: 401 }));
      },
    } satisfies Pick<ServerAuthShape, "authenticateHttpRequest">;
    const context = Context.make(ServerAuth, auth as unknown as ServerAuthShape).pipe(
      Context.add(TwoFactorService, {
        status: Effect.succeed({ enabled: false, recoveryCodesRemaining: 0 }),
        begin,
        enable,
        disable,
        verify: () => Effect.void,
      }),
    );
    const app = HttpRouter.toWebHandler(authTwoFactorRouteLayer, { disableLogger: true });
    try {
      for (const path of ["", "/setup", "/enable", "/disable"]) {
        expect((await app.handler(request(path, ""), context)).status).toBe(401);
        expect((await app.handler(request(path, "Bearer client"), context)).status).toBe(403);
      }
      expect(begin).not.toHaveBeenCalled();
      expect(enable).not.toHaveBeenCalled();
      expect(disable).not.toHaveBeenCalled();
      const setup = await app.handler(request("/setup", "Bearer owner"), context);
      expect(setup.headers.get("cache-control")).toBe("no-store");
      expect(await setup.json()).toEqual({ secret: "TEST", uri: "otpauth://test" });
      expect(begin).toHaveBeenCalledExactlyOnceWith(AuthSessionId.make("Bearer owner"));
      enable.mockImplementationOnce(
        () =>
          Effect.fail(
            new AuthError({
              message: "Too many authentication attempts. Try again later.",
              status: 429,
              retryAfterSeconds: 30,
            }),
          ) as never,
      );
      const refused = await app.handler(request("/enable", "Bearer owner"), context);
      expect(refused.status).toBe(429);
      expect(refused.headers.get("retry-after")).toBe("30");
      expect(refused.headers.has("set-cookie")).toBe(false);
      expect(await refused.json()).toEqual({
        error: "Too many authentication attempts. Try again later.",
      });
    } finally {
      await app.dispose();
    }
  });
});
