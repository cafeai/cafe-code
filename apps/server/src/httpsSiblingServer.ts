// @effect-diagnostics nodeBuiltinImport:off
import * as Http from "node:http";
import * as Https from "node:https";
import * as Net from "node:net";
import type { IncomingHttpHeaders } from "node:http";
import type { Duplex } from "node:stream";

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import { HttpServer } from "effect/unstable/http";

import { ServerConfig, type ServerConfigShape } from "./config.ts";
import { ensureHttpsCertificateMaterial, type HttpsCertificateError } from "./httpsCertificate.ts";
import { formatHostForUrl, isWildcardHost, resolveListeningPort } from "./startupAccess.ts";

export class HttpsSiblingServerError extends Data.TaggedError("HttpsSiblingServerError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message() {
    return `Failed to ${this.operation} HTTPS sibling server.`;
  }
}

const normalizeHostForConnect = (host: string): string => host.replace(/^\[(.*)\]$/, "$1");

const resolveProxyTargetHost = (host: string | undefined): string =>
  host && !isWildcardHost(host) ? normalizeHostForConnect(host) : "127.0.0.1";

const hostHeaderValue = (host: string, port: number): string => {
  const formattedHost = formatHostForUrl(host);
  return `${formattedHost}:${port}`;
};

const proxyHeaders = (input: {
  readonly headers: IncomingHttpHeaders;
  readonly targetHost: string;
  readonly targetPort: number;
}): IncomingHttpHeaders => ({
  ...input.headers,
  host: hostHeaderValue(input.targetHost, input.targetPort),
  "x-forwarded-proto": "https",
  "x-cafe-code-https-proxy": "1",
});

const writeHeaderLine = (socket: Net.Socket, name: string, value: string | readonly string[]) => {
  if (Array.isArray(value)) {
    for (const item of value) {
      socket.write(`${name}: ${item}\r\n`);
    }
    return;
  }
  socket.write(`${name}: ${value}\r\n`);
};

const proxyHttpRequest = (input: {
  readonly request: Http.IncomingMessage;
  readonly response: Http.ServerResponse;
  readonly targetHost: string;
  readonly targetPort: number;
}) => {
  const proxyRequest = Http.request(
    {
      hostname: input.targetHost,
      port: input.targetPort,
      path: input.request.url ?? "/",
      method: input.request.method,
      headers: proxyHeaders({
        headers: input.request.headers,
        targetHost: input.targetHost,
        targetPort: input.targetPort,
      }),
    },
    (proxyResponse) => {
      input.response.writeHead(
        proxyResponse.statusCode ?? 502,
        proxyResponse.statusMessage,
        proxyResponse.headers,
      );
      proxyResponse.pipe(input.response);
    },
  );

  proxyRequest.on("error", () => {
    if (!input.response.headersSent) {
      input.response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    }
    input.response.end("Cafe Code HTTPS proxy could not reach the local backend.");
  });

  input.request.pipe(proxyRequest);
};

const proxyWebSocketUpgrade = (input: {
  readonly request: Http.IncomingMessage;
  readonly socket: Duplex;
  readonly head: Buffer;
  readonly targetHost: string;
  readonly targetPort: number;
}) => {
  const targetSocket = Net.connect(
    {
      host: input.targetHost,
      port: input.targetPort,
    },
    () => {
      targetSocket.write(
        `${input.request.method ?? "GET"} ${input.request.url ?? "/"} HTTP/${
          input.request.httpVersion
        }\r\n`,
      );
      const headers = proxyHeaders({
        headers: input.request.headers,
        targetHost: input.targetHost,
        targetPort: input.targetPort,
      });
      for (const [name, value] of Object.entries(headers)) {
        if (value === undefined) continue;
        writeHeaderLine(targetSocket, name, value);
      }
      targetSocket.write("\r\n");
      if (input.head.length > 0) {
        targetSocket.write(input.head);
      }
      input.socket.pipe(targetSocket);
      targetSocket.pipe(input.socket);
    },
  );

  const closeBoth = () => {
    if (!input.socket.destroyed) input.socket.destroy();
    if (!targetSocket.destroyed) targetSocket.destroy();
  };

  targetSocket.on("error", closeBoth);
  input.socket.on("error", closeBoth);
  input.socket.on("close", closeBoth);
  targetSocket.on("close", closeBoth);
};

const listenHttpsServer = (server: Https.Server, config: ServerConfigShape, httpsPort: number) =>
  Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        const onError = (error: unknown) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen({
          port: httpsPort,
          ...(config.host ? { host: config.host } : {}),
        });
      }),
    catch: (cause) => new HttpsSiblingServerError({ operation: "listen", cause }),
  });

const closeHttpsServer = (server: Https.Server) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );

const acquireHttpsSiblingServer: Effect.Effect<
  Https.Server | null,
  HttpsSiblingServerError | HttpsCertificateError,
  ServerConfig | HttpServer.HttpServer
> = Effect.gen(function* () {
  const config = yield* ServerConfig;
  if (!config.httpsEnabled || config.httpsPort === undefined) {
    return null;
  }

  const httpServer = yield* HttpServer.HttpServer;
  const targetPort = resolveListeningPort(httpServer.address, config.port);
  const targetHost = resolveProxyTargetHost(config.host);
  const certificate = yield* ensureHttpsCertificateMaterial(config);

  const server = Https.createServer(
    {
      cert: certificate.cert,
      key: certificate.key,
    },
    (request, response) =>
      proxyHttpRequest({
        request,
        response,
        targetHost,
        targetPort,
      }),
  );
  server.on("upgrade", (request, socket, head) =>
    proxyWebSocketUpgrade({
      request,
      socket,
      head,
      targetHost,
      targetPort,
    }),
  );

  yield* listenHttpsServer(server, config, config.httpsPort);

  const address = server.address();
  const boundPort =
    typeof address === "object" && address !== null && "port" in address
      ? address.port
      : config.httpsPort;
  const host = config.host && !isWildcardHost(config.host) ? config.host : "127.0.0.1";
  yield* Effect.logInfo("HTTPS listener ready", {
    origin: `https://${formatHostForUrl(host)}:${boundPort}`,
    proxiedHttpPort: targetPort,
  });
  return server;
});

export const startHttpsSiblingServer: Effect.Effect<
  Https.Server | null,
  HttpsSiblingServerError | HttpsCertificateError,
  Scope.Scope | ServerConfig | HttpServer.HttpServer
> = Effect.acquireRelease(acquireHttpsSiblingServer, (server) =>
  server === null ? Effect.void : closeHttpsServer(server).pipe(Effect.ignore),
);
