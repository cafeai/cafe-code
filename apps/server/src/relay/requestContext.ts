import type { AuthSessionId } from "@cafecode/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AuthError, type AuthenticatedSession } from "../auth/Services/ServerAuth.ts";

/** Private in-process authority, provided only by an authenticated Noise owner. */
export class RelayRequestContext extends Context.Service<
  RelayRequestContext,
  {
    readonly sessionId: AuthSessionId;
    readonly validate: Effect.Effect<void, AuthError>;
  }
>()("cafecode/relay/RelayRequestContext") {}

export const validateRelayRequestSession = (session: AuthenticatedSession) =>
  Effect.gen(function* () {
    const relay = yield* Effect.serviceOption(RelayRequestContext);
    if (Option.isSome(relay)) {
      if (relay.value.sessionId !== session.sessionId || session.managementLaunchContext)
        return yield* new AuthError({ message: "Unauthorized request.", status: 401 });
      yield* relay.value.validate;
    }
    return session;
  });
