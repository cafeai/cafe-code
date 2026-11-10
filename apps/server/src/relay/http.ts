import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { RelayError } from "@cafecode/relay/errors";
import { Id16, Id32 } from "@cafecode/relay/protocol";
import { AuthError, ServerAuth } from "../auth/Services/ServerAuth.ts";
import { readControlJson } from "../httpBody.ts";
import { RelayRuntime } from "./runtime.ts";

const requestInvitation = Schema.Struct({
  networkId: Id32,
  role: Schema.Literals(["client", "owner"]),
});
const revokeInvitation = Schema.Struct({ id: Id16 });
const owner = Effect.gen(function* () {
  const auth = yield* ServerAuth,
    request = yield* HttpServerRequest.HttpServerRequest;
  const session = yield* auth.authenticateHttpRequest(request);
  if (session.role !== "owner")
    return yield* new AuthError({ message: "Owner access required.", status: 403 });
});
const failure = (error: unknown) =>
  HttpServerResponse.jsonUnsafe(
    { code: error instanceof RelayError ? error.code : "AUTH_REJECTED" },
    {
      status:
        error instanceof AuthError
          ? (error.status ?? 500)
          : error instanceof RelayError && error.code === "BUSY"
            ? 429
            : 503,
      headers: { "cache-control": "no-store" },
    },
  );
export const relayRoutesLayer = Layer.mergeAll(
  HttpRouter.add(
    "GET",
    "/api/relay",
    Effect.gen(function* () {
      yield* owner;
      const relay = yield* Effect.serviceOption(RelayRuntime);
      return HttpServerResponse.jsonUnsafe(
        Option.isSome(relay) ? yield* relay.value.status : { enabled: false, networks: [] },
        { headers: { "cache-control": "no-store" } },
      );
    }).pipe(Effect.catch((error) => Effect.succeed(failure(error)))),
  ),
  HttpRouter.add(
    "POST",
    "/api/relay/invitations",
    Effect.gen(function* () {
      yield* owner;
      const input = yield* readControlJson(requestInvitation);
      const relay = yield* Effect.serviceOption(RelayRuntime);
      if (Option.isNone(relay)) return yield* new RelayError("UNAVAILABLE");
      return HttpServerResponse.jsonUnsafe(
        yield* relay.value.invitation(input.networkId, input.role),
        { headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } },
      );
    }).pipe(Effect.catch((error) => Effect.succeed(failure(error)))),
  ),
  HttpRouter.add(
    "POST",
    "/api/relay/invitations/revoke",
    Effect.gen(function* () {
      yield* owner;
      const input = yield* readControlJson(revokeInvitation);
      const relay = yield* Effect.serviceOption(RelayRuntime);
      if (Option.isNone(relay)) return yield* new RelayError("UNAVAILABLE");
      yield* relay.value.revokeInvitation(input.id);
      return HttpServerResponse.empty({ status: 204, headers: { "cache-control": "no-store" } });
    }).pipe(Effect.catch((error) => Effect.succeed(failure(error)))),
  ),
);
