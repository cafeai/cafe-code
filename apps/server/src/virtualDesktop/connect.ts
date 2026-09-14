// @effect-diagnostics nodeBuiltinImport:off
import { timingSafeEqual } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { VirtualDesktopId, DesktopViewerAppearance } from "@cafecode/contracts";
import { ServerConfig } from "../config.ts";
import { makeDesktopService } from "./service.ts";

const HostEnvironment = Schema.Struct({
  DISPLAY: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2048))),
  WAYLAND_DISPLAY: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2048))),
  XDG_RUNTIME_DIR: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2048))),
  XAUTHORITY: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2048))),
  DBUS_SESSION_BUS_ADDRESS: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2048))),
});
const decodeConnectRequest = Schema.decodeUnknownEffect(
  Schema.Struct({
    id: VirtualDesktopId,
    environment: HostEnvironment,
    appearance: Schema.optionalKey(DesktopViewerAppearance),
  }),
);
export const desktopConnectRouteLayer = HttpRouter.add(
  "POST",
  "/api/virtual-desktops/connect",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig;
    const supplied = request.headers.authorization?.slice(7) ?? "";
    const expected = config.desktopBootstrapToken;
    const local = Option.getOrElse(request.remoteAddress, () => "");
    // Only the matching Electron instance has this bootstrap credential. Browser
    // owner sessions and desktop MCP capabilities cannot open a host-side window.
    if (
      process.platform !== "linux" ||
      config.mode !== "desktop" ||
      !expected ||
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(local) ||
      !request.headers.authorization?.startsWith("Bearer ") ||
      Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    )
      return HttpServerResponse.jsonUnsafe(
        { error: "A matching local desktop client is required." },
        { status: 403 },
      );
    const service = yield* makeDesktopService;
    const result = yield* Effect.gen(function* () {
      const input = yield* decodeConnectRequest(yield* request.json);
      yield* service.request({ operation: "connect", ...input });
      return HttpServerResponse.jsonUnsafe({ ok: true });
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            { error: "Could not open the desktop viewer." },
            { status: 503 },
          ),
        ),
      ),
    );
    return result;
  }),
);
