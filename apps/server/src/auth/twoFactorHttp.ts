import { AuthTwoFactorCodeInput } from "@cafecode/contracts/auth";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { readControlJson } from "../httpBody.ts";
import { browserApiCorsHeaders } from "../httpCors.ts";
import { respondToAuthError } from "./http.ts";
import { AuthError, ServerAuth } from "./Services/ServerAuth.ts";
import { TwoFactorService } from "./Services/TwoFactorService.ts";

const owner = Effect.gen(function* () {
  const auth = yield* ServerAuth;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const session = yield* auth.authenticateHttpRequest(request);
  if (session.role !== "owner")
    return yield* new AuthError({
      message: "Only owners can manage two-factor authentication.",
      status: 403,
    });
  return session;
});
const code = readControlJson(AuthTwoFactorCodeInput).pipe(
  Effect.mapError(
    () => new AuthError({ message: "Invalid authentication code payload.", status: 400 }),
  ),
);
const json = (body: unknown) =>
  HttpServerResponse.jsonUnsafe(body, {
    headers: { ...browserApiCorsHeaders, "cache-control": "no-store" },
  });

export const authTwoFactorRouteLayer = Layer.mergeAll(
  HttpRouter.add(
    "GET",
    "/api/auth/two-factor",
    Effect.gen(function* () {
      yield* owner;
      const twoFactor = yield* TwoFactorService;
      return json(yield* twoFactor.status);
    }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
  ),
  HttpRouter.add(
    "POST",
    "/api/auth/two-factor/setup",
    Effect.gen(function* () {
      const session = yield* owner;
      const twoFactor = yield* TwoFactorService;
      return json(yield* twoFactor.begin(session.sessionId));
    }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
  ),
  HttpRouter.add(
    "POST",
    "/api/auth/two-factor/enable",
    Effect.gen(function* () {
      const session = yield* owner;
      const twoFactor = yield* TwoFactorService;
      const payload = yield* code;
      return json(yield* twoFactor.enable(session.sessionId, payload.code));
    }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
  ),
  HttpRouter.add(
    "POST",
    "/api/auth/two-factor/disable",
    Effect.gen(function* () {
      yield* owner;
      const twoFactor = yield* TwoFactorService;
      const payload = yield* code;
      yield* twoFactor.disable(payload.code);
      return json({ enabled: false, recoveryCodesRemaining: 0 });
    }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
  ),
);
