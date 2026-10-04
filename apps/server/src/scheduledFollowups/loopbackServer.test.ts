// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import assert from "node:assert/strict";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { ServerConfig } from "../config.ts";
import { ScheduledFollowups } from "./service.ts";
import {
  schedulingLoopbackApplication,
  schedulingLoopbackListenPort,
  startSchedulingLoopbackServer,
} from "./loopbackServer.ts";

const unused = () =>
  Effect.die(new Error("The unauthenticated listener must not call a scheduling service."));
const testServices = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), process.cwd()),
  Layer.succeed(ScheduledFollowups, {
    list: unused,
    save: unused,
    setStatus: unused,
    runNow: unused,
    history: unused,
    notification: unused,
    tick: unused(),
    start: unused,
  }),
).pipe(Layer.provideMerge(NodeHttpServer.layerHttpServices));

it("selects a second listener only when the bound main address lacks IPv4 loopback", () => {
  for (const hostname of ["127.0.0.1", "::ffff:127.0.0.1", "0.0.0.0", "::"])
    assert.equal(schedulingLoopbackListenPort({ _tag: "TcpAddress", hostname, port: 43210 }), null);
  for (const hostname of ["::1", "192.0.2.10", "100.64.1.10", "127.0.0.2", "2001:db8::1"])
    assert.equal(
      schedulingLoopbackListenPort({ _tag: "TcpAddress", hostname, port: 43210 }),
      43210,
    );
  for (const port of [0, -1, 65536, 1.5, Number.NaN])
    assert.throws(
      () => schedulingLoopbackListenPort({ _tag: "TcpAddress", hostname: "::1", port }),
      /private scheduling listener/u,
    );
  assert.throws(
    () => schedulingLoopbackListenPort({ _tag: "UnixAddress", path: "private-fixture-socket" }),
    /private scheduling listener/u,
  );
});

it.effect(
  "does not bind a duplicate socket when the main listener already accepts the bridge",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const main = yield* NodeHttpServer.make(NodeHttp.createServer, {
          host: "127.0.0.1",
          port: 0,
        });
        yield* main.serve(Effect.succeed(HttpServerResponse.text("main-only")));
        const result = yield* startSchedulingLoopbackServer.pipe(
          Effect.provideService(HttpServer.HttpServer, main),
        );
        assert.equal(result, null);
      }),
    ).pipe(Effect.provide(testServices)),
);

it.effect(
  "rejects management paths and preserves scheduling authentication on the narrow application",
  () =>
    Effect.gen(function* () {
      for (const [method, pathname] of [
        ["POST", "/mcp"],
        ["POST", "/mcp/desktop"],
        ["GET", "/mcp/scheduling"],
        ["POST", "/mcp/scheduling?target=other"],
        ["GET", "/auth/session"],
      ] as const) {
        const response = yield* schedulingLoopbackApplication.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(new Request(`http://127.0.0.1${pathname}`, { method })),
          ),
        );
        assert.equal(response.status, 404);
      }
    }).pipe(Effect.provide(testServices)),
);

it.effect("fails closed when another socket already owns the required loopback port", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const occupied = yield* NodeHttpServer.make(NodeHttp.createServer, {
        host: "127.0.0.1",
        port: 0,
      });
      assert.equal(occupied.address._tag, "TcpAddress");
      if (occupied.address._tag !== "TcpAddress") return;
      const main = HttpServer.make({
        address: { _tag: "TcpAddress", hostname: "192.0.2.10", port: occupied.address.port },
        serve: () => Effect.void,
      });
      const result = yield* Effect.scoped(startSchedulingLoopbackServer).pipe(
        Effect.provideService(HttpServer.HttpServer, main),
        Effect.result,
      );
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "SchedulingLoopbackServerError");
        assert.doesNotMatch(
          JSON.stringify(result.failure),
          /192\.0\.2\.10|EADDRINUSE|127\.0\.0\.1/u,
        );
      }
      assert.equal(occupied.address.port > 0, true);
    }),
  ).pipe(Effect.provide(testServices)),
);

it.effect(
  "serves only scheduling on IPv4 at the IPv6 main listener's assigned port and closes its scope",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        // ::1 is a separate local address on every supported host. Both listeners
        // remain process-local fixtures; no LAN interface, provider or profile is
        // needed to qualify the same-port IPv4/IPv6 behavior.
        const main = yield* NodeHttpServer.make(NodeHttp.createServer, { host: "::1", port: 0 });
        yield* main.serve(Effect.succeed(HttpServerResponse.text("main-only")));
        assert.equal(main.address._tag, "TcpAddress");
        if (main.address._tag !== "TcpAddress") return;
        const mainPort = main.address.port;
        const listenerScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(listenerScope, Exit.void));
        const address = yield* startSchedulingLoopbackServer.pipe(
          Effect.provideService(HttpServer.HttpServer, main),
          Effect.provideService(Scope.Scope, listenerScope),
        );
        assert.deepEqual(address, {
          _tag: "TcpAddress",
          hostname: "127.0.0.1",
          port: mainPort,
        });
        const baseUrl = `http://127.0.0.1:${mainPort}`;
        for (const [pathname, expectedStatus] of [
          ["/mcp/scheduling", 401],
          ["/mcp", 404],
          ["/mcp/desktop", 404],
          ["/auth/session", 404],
        ] as const) {
          const response = yield* Effect.promise(() =>
            fetch(`${baseUrl}${pathname}`, { method: "POST", signal: AbortSignal.timeout(2000) }),
          );
          assert.equal(response.status, expectedStatus);
          yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve());
        }
        yield* Scope.close(listenerScope, Exit.void);
        // The main interface keeps serving after the narrow sibling closes.
        const response = yield* Effect.promise(() =>
          fetch(`http://[::1]:${mainPort}`, { signal: AbortSignal.timeout(2000) }),
        );
        assert.equal(yield* Effect.promise(() => response.text()), "main-only");
        const closed = yield* Effect.tryPromise({
          try: () => fetch(baseUrl, { signal: AbortSignal.timeout(2000) }),
          catch: () => null,
        }).pipe(Effect.result);
        assert.equal(closed._tag, "Failure");
      }),
    ).pipe(Effect.provide(testServices)),
);
