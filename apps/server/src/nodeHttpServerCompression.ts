// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { NodeWS } from "@effect/platform-node/NodeSocket";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { flow, type LazyArg } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as HttpServer from "effect/unstable/http/HttpServer";
import { ServeError } from "effect/unstable/http/HttpServerError";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

const WEBSOCKET_COMPRESSION_OPTIONS = {
  clientNoContextTakeover: true,
  serverNoContextTakeover: true,
  concurrencyLimit: 10,
  threshold: 1024,
} as const;

const make = Effect.fnUntraced(function* (
  evaluate: LazyArg<NodeHttp.Server>,
  options: NodeNet.ListenOptions & {
    readonly disablePreemptiveShutdown?: boolean;
    readonly gracefulShutdownTimeout?: Duration.Input;
  },
) {
  const scope = yield* Effect.scope;
  const server = evaluate();
  const shutdown = yield* Effect.callback<void>((resume) => {
    if (!server.listening) {
      return resume(Effect.void);
    }
    server.close((error) => {
      if (error) {
        resume(Effect.die(error));
      } else {
        resume(Effect.void);
      }
    });
  }).pipe(Effect.cached);
  const preemptiveShutdown = options.disablePreemptiveShutdown
    ? Effect.void
    : Effect.timeoutOrElse(shutdown, {
        duration: options.gracefulShutdownTimeout ?? Duration.seconds(20),
        orElse: () => Effect.void,
      });

  yield* Scope.addFinalizer(scope, shutdown);
  yield* Effect.callback<void, ServeError>((resume) => {
    function onError(cause: Error) {
      resume(Effect.fail(new ServeError({ cause })));
    }
    server.on("error", onError);
    server.listen(options, () => {
      server.off("error", onError);
      resume(Effect.void);
    });
  });

  const address = server.address();
  const wss = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new NodeWS.WebSocketServer({
          noServer: true,
          perMessageDeflate: WEBSOCKET_COMPRESSION_OPTIONS,
        }),
    ),
    (webSocketServer) =>
      Effect.callback<void>((resume) => {
        webSocketServer.close(() => resume(Effect.void));
      }),
  );
  const wssEffect = Effect.succeed(wss);

  return HttpServer.make({
    address:
      typeof address === "string"
        ? {
            _tag: "UnixAddress",
            path: address,
          }
        : {
            _tag: "TcpAddress",
            hostname: address?.address === "::" ? "0.0.0.0" : (address?.address ?? "0.0.0.0"),
            port: address?.port ?? 0,
          },
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off - This mirrors the platform-node server adapter boundary, where route errors are handled by the HTTP interpreter.
    serve: Effect.fnUntraced(function* (httpApp, middleware) {
      const serveScope = yield* Effect.scope;
      const requestScope = Scope.forkUnsafe(serveScope, "parallel");
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off - The public Effect HTTP adapter accepts generic route effects here.
      const handler = yield* NodeHttpServer.makeHandler(httpApp, {
        middleware,
        scope: requestScope,
      });
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off - The public Effect WebSocket adapter accepts generic route effects here.
      const upgradeHandler = yield* NodeHttpServer.makeUpgradeHandler(wssEffect, httpApp, {
        middleware,
        scope: requestScope,
      });
      yield* Scope.addFinalizerExit(serveScope, () => {
        server.off("request", handler);
        server.off("upgrade", upgradeHandler);
        return preemptiveShutdown;
      });
      server.on("request", handler);
      server.on("upgrade", upgradeHandler);
    }),
  });
});

export const layerServer = flow(make, Layer.effect(HttpServer.HttpServer));

export const layer = (evaluate: LazyArg<NodeHttp.Server>, options: NodeNet.ListenOptions) =>
  Layer.mergeAll(layerServer(evaluate, options), NodeHttpServer.layerHttpServices);
