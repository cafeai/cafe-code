import { DESKTOP_OBSERVATION_PATH, ThreadId, VirtualDesktopId } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { AuthError, ServerAuth } from "../auth/Services/ServerAuth.ts";
import { respondToAuthError } from "../auth/http.ts";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { browserApiCorsHeaders } from "../httpCors.ts";
import { makeDesktopObservationStore } from "./observationStore.ts";

const headers = {
  ...browserApiCorsHeaders,
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
};
let activeReads = 0;
const validId = Schema.is(VirtualDesktopId);
const validThreadId = Schema.is(ThreadId);

export const handleDesktopObservationRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const session = yield* (yield* ServerAuth).authenticateHttpRequest(request);
  if (session.role !== "owner")
    return yield* new AuthError({ message: "Owner access required.", status: 403 });
  const url = HttpServerRequest.toURL(request);
  const id = Option.isSome(url)
    ? url.value.pathname.slice(DESKTOP_OBSERVATION_PATH.length + 1)
    : "";
  const threadId = Option.isSome(url) ? url.value.searchParams.get("threadId") : null;
  if (!validId(id) || !validThreadId(threadId))
    return HttpServerResponse.empty({ status: 400, headers });
  const config = yield* ServerConfig;
  const settings = yield* ServerSettingsService;
  const store = yield* makeDesktopObservationStore(config.stateDir);
  const limit = (yield* settings.getSettings).desktopObservationRetention;
  if (activeReads >= 4) return HttpServerResponse.empty({ status: 429, headers });
  activeReads++;
  // Authenticate before touching artifacts. The exact thread is checked again
  // after reading bytes; no path, token, or PNG is sent through the RPC ledger.
  return yield* Effect.tryPromise(() => store.read(id, threadId, limit)).pipe(
    // Node filesystem promises cannot be cancelled. Hold admission until the
    // bounded read actually finishes even when the HTTP client disconnects.
    Effect.uninterruptible,
    Effect.map((bytes) =>
      bytes
        ? HttpServerResponse.uint8Array(bytes, { contentType: "image/png", headers })
        : HttpServerResponse.empty({ status: 404, headers }),
    ),
    Effect.catch((error) =>
      Effect.succeed(
        HttpServerResponse.empty({
          status: (error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT" ? 404 : 503,
          headers,
        }),
      ),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        activeReads--;
      }),
    ),
  );
}).pipe(Effect.catchTag("AuthError", respondToAuthError));

export const desktopObservationRouteLayer = HttpRouter.add(
  "GET",
  `${DESKTOP_OBSERVATION_PATH}/*`,
  handleDesktopObservationRequest,
);
