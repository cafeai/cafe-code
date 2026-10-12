import { CHAT_IMAGES_PATH } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { ServerAuth } from "../auth/Services/ServerAuth.ts";
import { respondToAuthError } from "../auth/http.ts";
import { browserApiCorsHeaders } from "../httpCors.ts";
import { ChatImages } from "./service.ts";

const headers = {
  ...browserApiCorsHeaders,
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
};
let activeReads = 0;
export const handleChatImageRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  // Guests already have read-only chat access. Both cookie and saved-server
  // bearer sessions use the same authenticated transport and ownership query.
  yield* (yield* ServerAuth).authenticateHttpRequest(request);
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return HttpServerResponse.empty({ status: 400, headers });
  const { searchParams } = url.value;
  const threadId = searchParams.get("threadId");
  const messageId = searchParams.get("messageId");
  if (!threadId || !messageId || threadId.length > 512 || messageId.length > 1024)
    return HttpServerResponse.empty({ status: 400, headers });
  if (activeReads >= 4) return HttpServerResponse.empty({ status: 429, headers });
  activeReads++;
  return yield* Effect.gen(function* () {
    const images = yield* ChatImages;
    const source = searchParams.get("source");
    if (source === null) {
      // Supports historical replies and covers a viewer arriving before the
      // background publication worker. The client supplies identity, never
      // an arbitrary filesystem path to import.
      yield* images.publish(threadId, messageId);
      return HttpServerResponse.jsonUnsafe(yield* images.manifest(threadId, messageId), {
        headers,
      });
    }
    if (source.length > 32_768) return HttpServerResponse.empty({ status: 400, headers });
    const image = yield* images.read(threadId, messageId, source);
    return image
      ? HttpServerResponse.uint8Array(image.bytes, {
          contentType: image.metadata.mimeType,
          headers,
        })
      : HttpServerResponse.empty({ status: 404, headers });
  }).pipe(
    Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 503, headers }))),
    Effect.ensuring(
      Effect.sync(() => {
        activeReads--;
      }),
    ),
  );
}).pipe(Effect.catchTag("AuthError", respondToAuthError));
export const chatImageRouteLayer = HttpRouter.add("GET", CHAT_IMAGES_PATH, handleChatImageRequest);
