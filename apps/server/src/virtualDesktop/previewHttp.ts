import {
  DESKTOP_PREVIEW_PATH,
  DESKTOP_PREVIEW_MAX_BYTES,
  VirtualDesktopId,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { AuthError, ServerAuth } from "../auth/Services/ServerAuth.ts";
import { respondToAuthError } from "../auth/http.ts";
import { browserApiCorsHeaders } from "../httpCors.ts";
import { makeDesktopService } from "./service.ts";

const headers = {
  ...browserApiCorsHeaders,
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
};
const validId = Schema.is(VirtualDesktopId);

/** Preview bytes use authenticated HTTP, never config snapshots or the event
 * journal. Capture is owner-only even when an agent has a desktop capability. */
export const handleDesktopPreviewRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const session = yield* (yield* ServerAuth).authenticateHttpRequest(request);
  if (session.role !== "owner")
    return yield* new AuthError({ message: "Owner access required.", status: 403 });
  const url = HttpServerRequest.toURL(request);
  const id = Option.isSome(url) ? url.value.pathname.slice(DESKTOP_PREVIEW_PATH.length + 1) : "";
  if (!validId(id)) return HttpServerResponse.empty({ status: 400, headers });
  const service = yield* makeDesktopService;
  return yield* service.request({ operation: "preview", id }).pipe(
    Effect.map((result) => {
      const image =
        typeof result === "object" && result !== null && "image" in result ? result.image : null;
      if (
        typeof image !== "string" ||
        image.length > Math.ceil(DESKTOP_PREVIEW_MAX_BYTES / 3) * 4 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(image)
      )
        return HttpServerResponse.empty({ status: 503, headers });
      const bytes = Buffer.from(image, "base64");
      if (
        bytes.length > DESKTOP_PREVIEW_MAX_BYTES ||
        !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      )
        return HttpServerResponse.empty({ status: 503, headers });
      return HttpServerResponse.uint8Array(bytes, { contentType: "image/png", headers });
    }),
    Effect.catch((error) =>
      Effect.succeed(
        HttpServerResponse.empty({
          status: error.code === "busy" ? 429 : error.code === "feature_disabled" ? 403 : 404,
          headers,
        }),
      ),
    ),
  );
}).pipe(Effect.catchTag("AuthError", respondToAuthError));

export const desktopPreviewRouteLayer = HttpRouter.add(
  "GET",
  `${DESKTOP_PREVIEW_PATH}/*`,
  handleDesktopPreviewRequest,
);
