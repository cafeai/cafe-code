// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { handleSchedulingMcpRequest } from "./http.ts";

/** A fixed error deliberately omits listener addresses, process errors and any
 * request context. A conflicting local listener must never make Cafe advertise
 * another process's port or silently choose a different provider bridge port. */
export class SchedulingLoopbackServerError extends Data.TaggedError(
  "SchedulingLoopbackServerError",
)<{}> {
  override get message() {
    return "Could not start the private scheduling listener. Check that the backend port is available on IPv4 loopback.";
  }
}

export function schedulingLoopbackListenPort(address: HttpServer.Address): number | null {
  if (
    address._tag !== "TcpAddress" ||
    !Number.isInteger(address.port) ||
    address.port < 1 ||
    address.port > 65535
  )
    throw new SchedulingLoopbackServerError();
  // Read the address which actually bound, not config.host: localhost can
  // resolve to ::1, and a fixture configured with port 0 already has an assigned
  // port here. The main Node listener never sets ipv6Only, so :: accepts IPv4
  // too (the current adapter normalizes that address to 0.0.0.0).
  if (["127.0.0.1", "::ffff:127.0.0.1", "0.0.0.0", "::"].includes(address.hostname)) return null;
  return address.port;
}

/** The secondary socket owns only the internal scheduling audience. Do not
 * mount makeRoutesLayer, proxy arbitrary paths, add owner auth, or expose the
 * management MCP/server APIs merely to support a custom LAN/Tailnet bind. */
export const schedulingLoopbackApplication = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (request.method !== "POST" || request.url !== "/mcp/scheduling")
    return HttpServerResponse.empty({ status: 404 });
  return yield* handleSchedulingMcpRequest;
});

/** Share the main backend's exact port while keeping its configured interface
 * unchanged. Detached provider bridges already carry that stable port, so a
 * random fallback would strand their private connection files after startup.
 * Scope ownership includes request cancellation and the native socket; a failed
 * second bind propagates before backend startup can be reported successful. */
export const startSchedulingLoopbackServer = Effect.gen(function* () {
  const main = yield* HttpServer.HttpServer;
  const port = yield* Effect.try({
    try: () => schedulingLoopbackListenPort(main.address),
    catch: () => new SchedulingLoopbackServerError(),
  });
  if (port === null) return null;
  const sibling = yield* NodeHttpServer.make(NodeHttp.createServer, {
    host: "127.0.0.1",
    port,
  });
  yield* sibling.serve(schedulingLoopbackApplication);
  return sibling.address;
}).pipe(Effect.mapError(() => new SchedulingLoopbackServerError()));
