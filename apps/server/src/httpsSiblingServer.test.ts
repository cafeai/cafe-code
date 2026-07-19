// @effect-diagnostics nodeBuiltinImport:off
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Http from "node:http";
import * as Https from "node:https";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpServer } from "effect/unstable/http";

import { deriveServerPaths, ServerConfig, type ServerConfigShape } from "./config.ts";
import { startHttpsSiblingServer } from "./httpsSiblingServer.ts";

const EVENT_TIMEOUT_MS = 2_000;

interface TestBackend {
  readonly server: Http.Server;
  readonly webSocketServer: NodeSocket.NodeWS.WebSocketServer;
  readonly port: number;
  readonly upgradeHeaders: Http.IncomingHttpHeaders[];
}

const closeHttpServer = (server: Http.Server) =>
  new Promise<void>((resolve) => {
    server.close(() => resolve());
  });

const makeTestBackend = Effect.acquireRelease(
  Effect.tryPromise({
    try: () =>
      new Promise<TestBackend>((resolve, reject) => {
        const upgradeHeaders: Http.IncomingHttpHeaders[] = [];
        const webSocketServer = new NodeSocket.NodeWS.WebSocketServer({
          noServer: true,
          perMessageDeflate: {
            clientNoContextTakeover: true,
            serverNoContextTakeover: true,
            concurrencyLimit: 10,
            threshold: 1_024,
          },
        });
        webSocketServer.on("connection", (socket) => {
          socket.on("message", (message, isBinary) => socket.send(message, { binary: isBinary }));
        });

        const server = Http.createServer((_request, response) => {
          response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          response.end("backend-ok");
        });
        server.on("upgrade", (request, socket, head) => {
          upgradeHeaders.push(request.headers);
          webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
            webSocketServer.emit("connection", webSocket, request);
          });
        });

        const onError = (cause: Error) => {
          server.off("listening", onListening);
          reject(cause);
        };
        const onListening = () => {
          server.off("error", onError);
          const address = server.address();
          if (typeof address !== "object" || address === null) {
            reject(new Error("Test backend did not bind a TCP address"));
            return;
          }
          resolve({ server, webSocketServer, port: address.port, upgradeHeaders });
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen({ host: "127.0.0.1", port: 0 });
      }),
    catch: (cause) => new Error("Failed to start test backend", { cause }),
  }),
  ({ server, webSocketServer }) =>
    Effect.promise(async () => {
      for (const client of webSocketServer.clients) {
        client.terminate();
      }
      await Promise.all([
        new Promise<void>((resolve) => webSocketServer.close(() => resolve())),
        closeHttpServer(server),
      ]);
    }),
);

const makeHttpsTestConfig = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "cafe-https-proxy-test-" });
  const derivedPaths = yield* deriveServerPaths(baseDir, undefined);

  return {
    logLevel: "Error",
    traceMinLevel: "Info",
    traceTimingEnabled: true,
    traceBatchWindowMs: 200,
    traceMaxBytes: 10 * 1024 * 1024,
    traceMaxFiles: 10,
    otlpTracesUrl: undefined,
    otlpMetricsUrl: undefined,
    otlpExportIntervalMs: 10_000,
    otlpServiceName: "cafe-code-server",
    mode: "web",
    port: 0,
    httpsEnabled: true,
    httpsPort: 0,
    host: "127.0.0.1",
    cwd: process.cwd(),
    baseDir,
    ...derivedPaths,
    staticDir: undefined,
    devUrl: undefined,
    noBrowser: true,
    startupPresentation: "browser",
    desktopBootstrapToken: undefined,
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
    providerDaemon: undefined,
    providerSupervisor: undefined,
  } satisfies ServerConfigShape;
});

const makeHttpServerService = (port: number) =>
  HttpServer.make({
    address: {
      _tag: "TcpAddress",
      hostname: "127.0.0.1",
      port,
    },
    serve: () => Effect.void,
  });

const listenPort = (server: Https.Server): number => {
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("HTTPS sibling did not bind a TCP address");
  }
  return address.port;
};

const openWebSocket = (url: string, certificate: string) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        new Promise<NodeSocket.NodeWS.WebSocket>((resolve, reject) => {
          const socket = new NodeSocket.NodeWS.WebSocket(url, {
            ca: certificate,
            headers: { cookie: "cafe_session=test-session" },
            perMessageDeflate: true,
          });
          const timeout = setTimeout(() => {
            socket.terminate();
            reject(new Error("Timed out opening WSS connection"));
          }, EVENT_TIMEOUT_MS);
          const cleanup = () => {
            clearTimeout(timeout);
            socket.off("open", onOpen);
            socket.off("error", onError);
            socket.off("close", onClose);
          };
          const onOpen = () => {
            cleanup();
            resolve(socket);
          };
          const onError = (cause: Error) => {
            cleanup();
            socket.terminate();
            reject(cause);
          };
          const onClose = () => {
            cleanup();
            reject(new Error("WSS connection closed before opening"));
          };
          socket.once("open", onOpen);
          socket.once("error", onError);
          socket.once("close", onClose);
        }),
      catch: (cause) => new Error("Failed to open WSS connection", { cause }),
    }),
    (socket) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            if (socket.readyState === NodeSocket.NodeWS.WebSocket.CLOSED) {
              resolve();
              return;
            }
            const timeout = setTimeout(() => {
              socket.terminate();
              resolve();
            }, EVENT_TIMEOUT_MS);
            socket.once("close", () => {
              clearTimeout(timeout);
              resolve();
            });
            socket.close();
          }),
      ),
  );

const sendAndWaitForMessage = (socket: NodeSocket.NodeWS.WebSocket, payload: string) =>
  Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error("Timed out waiting for WSS message"));
        }, EVENT_TIMEOUT_MS);
        const cleanup = () => {
          clearTimeout(timeout);
          socket.off("message", onMessage);
          socket.off("error", onError);
          socket.off("close", onClose);
        };
        const onMessage = (message: NodeSocket.NodeWS.RawData) => {
          cleanup();
          resolve(message.toString());
        };
        const onError = (cause: Error) => {
          cleanup();
          reject(cause);
        };
        const onClose = () => {
          cleanup();
          reject(new Error("WSS connection closed before receiving a message"));
        };
        socket.once("message", onMessage);
        socket.once("error", onError);
        socket.once("close", onClose);
        socket.send(payload, (cause) => {
          if (cause) {
            cleanup();
            reject(cause);
          }
        });
      }),
    catch: (cause) => new Error("Failed while waiting for WSS message", { cause }),
  });

const reserveClosedPort = Effect.tryPromise({
  try: () =>
    new Promise<number>((resolve, reject) => {
      const server = Http.createServer();
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: 0 }, () => {
        const address = server.address();
        if (typeof address !== "object" || address === null) {
          reject(new Error("Port reservation did not bind a TCP address"));
          return;
        }
        const port = address.port;
        server.close((error) => {
          if (error) reject(error);
          else resolve(port);
        });
      });
    }),
  catch: (cause) => new Error("Failed to reserve a closed test port", { cause }),
});

it.layer(NodeServices.layer)("HTTPS sibling WebSocket proxy", (it) => {
  it.effect("proxies a compressed WSS connection with auth and proxy headers intact", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* makeTestBackend;
        const config = yield* makeHttpsTestConfig;
        const sibling = yield* startHttpsSiblingServer.pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(ServerConfig, config),
              Layer.succeed(HttpServer.HttpServer, makeHttpServerService(backend.port)),
            ),
          ),
        );
        assert.isNotNull(sibling);
        if (sibling === null) return;

        const fs = yield* FileSystem.FileSystem;
        const certificate = yield* fs.readFileString(config.httpsCertPath);
        const payload = `wss-payload-${"0123456789abcdef".repeat(512)}`;
        const socket = yield* openWebSocket(
          `wss://127.0.0.1:${listenPort(sibling)}/ws?transport=test`,
          certificate,
        );

        assert.include(socket.extensions, "permessage-deflate");
        const echoed = yield* sendAndWaitForMessage(socket, payload);
        assert.equal(echoed, payload);

        const headers = backend.upgradeHeaders[0];
        assert.isDefined(headers);
        assert.equal(headers?.host, `127.0.0.1:${backend.port}`);
        assert.equal(headers?.["x-forwarded-proto"], "https");
        assert.equal(headers?.["x-cafe-code-https-proxy"], "1");
        assert.equal(headers?.cookie, "cafe_session=test-session");
      }),
    ),
  );

  it.effect("closes a WSS handshake promptly when the local backend is unavailable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const closedPort = yield* reserveClosedPort;
        const config = yield* makeHttpsTestConfig;
        const sibling = yield* startHttpsSiblingServer.pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(ServerConfig, config),
              Layer.succeed(HttpServer.HttpServer, makeHttpServerService(closedPort)),
            ),
          ),
        );
        assert.isNotNull(sibling);
        if (sibling === null) return;

        const fs = yield* FileSystem.FileSystem;
        const certificate = yield* fs.readFileString(config.httpsCertPath);
        const failure = yield* Effect.flip(
          Effect.scoped(openWebSocket(`wss://127.0.0.1:${listenPort(sibling)}/ws`, certificate)),
        );
        assert.instanceOf(failure, Error);
      }),
    ),
  );
});
