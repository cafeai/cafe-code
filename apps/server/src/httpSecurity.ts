import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import {
  CAFE_CODE_HTTPS_CERTIFICATE_PATH,
  CAFE_CODE_ENVIRONMENT_ENDPOINT_PATH,
} from "@cafecode/shared/environmentEndpoint";
import { ServerConfig } from "./config.ts";
import { isHttpsProxyRequest, isLocalPeer } from "./httpTransport.ts";

export const httpSecurityLayer = HttpRouter.middleware(
  (handler) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const path = request.url.split("?", 1)[0] ?? "";
      if (
        config.httpsEnabled &&
        config.httpsPort !== undefined &&
        !(
          (request.method === "GET" || request.method === "HEAD") &&
          ["/", CAFE_CODE_HTTPS_CERTIFICATE_PATH, CAFE_CODE_ENVIRONMENT_ENDPOINT_PATH].includes(
            path,
          )
        ) &&
        !isHttpsProxyRequest(request) &&
        !isLocalPeer(Option.getOrElse(request.remoteAddress, () => ""))
      ) {
        return HttpServerResponse.text("A secure connection is required.", {
          status: 403,
          headers: { "cache-control": "no-store", connection: "close" },
        });
      }
      return yield* handler;
    }),
  { global: true },
);
